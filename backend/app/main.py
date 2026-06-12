"""FastAPI app — filesystem-backed review server.

Endpoints (under /api unless noted):

- GET  /tree                                 file tree under ROOT_DIR
- GET  /documents                            recently opened documents
- POST /documents/open  {rel_path}           open or refresh a file; returns doc + sections + reviews
- GET  /documents/{id}                       refresh an already-opened document
- PATCH /documents/{id}  {context_paths}     update context selection
- POST /documents/{id}/save_version          write applied edits to <name>_v<N>.md and return new rel_path
- POST /documents/{id}/sections/{s_idx}/paragraphs/{p_idx}/review
                                             generate reviewer turn for one paragraph
- POST /reviews/{id}/accept  {user_comment}  resolve a review
- POST /reviews/{id}/reject  {user_comment}  resolve a review
- GET  /files/{rel_path}                     raw file body (used for previewing context)
- GET  /audio/{rel_path}                     serve generated audio
"""

from __future__ import annotations

# Load .env BEFORE importing modules that read env vars at module-load time
# (fs.py for ROOT_DIR, db.py for DATABASE_URL, pipeline.py for AUDIO_DIR).
from dotenv import load_dotenv
load_dotenv()

from .logging_config import setup_logging
setup_logging()

import io
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from openai import OpenAI

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlmodel import Session, or_, select
from starlette.middleware.sessions import SessionMiddleware

from . import fs
from .admin import router as admin_router
from .auth import router as auth_router
from .billing import router as billing_router, check_usage_limits, record_usage
from .email_inbound import router as email_router
from .export import router as export_router
from .health import router as health_router
from .telegram import router as telegram_router
from .drive_auth import router as drive_auth_router
from .db import engine, get_session, init_db
# Trigger storage provider registration on import
from .storage import google_drive as _unused_gdrive  # noqa: F401
from .storage.helpers import get_user_storage
from .middleware import get_current_user, limiter, tier_limit
from .models import AppSettings, Document, Review, ReviewStatus, UsageRecord, User, UserComment

_log = logging.getLogger(__name__)
from .pipeline import (
    SectionHistoryEntry,
    cost_usd,
    ensure_paragraph_narrator,
    get_current_settings,
    narrator_respond,
    propose_replacement,
    relative_audio_path,
    review_paragraph,
    split_paragraphs,
    strip_toc,
    synthesise_paragraph_narrator,
    synthesise_paragraph_reviewer,
    synthesise_response_audio,
    parse_markdown,
)


def _bill(review: "Review", *, usage=None, tts_chars: int = 0) -> None:
    """Accumulate token/char usage onto a Review row.

    `usage` is an `agents.usage.Usage` (or anything with input_tokens/output_tokens);
    `tts_chars` is the count returned by the synthesise/ensure helpers. Cost is
    derived on serialize via pipeline.cost_usd."""
    if usage is not None:
        review.llm_input_tokens = (review.llm_input_tokens or 0) + (usage.input_tokens or 0)
        review.llm_output_tokens = (review.llm_output_tokens or 0) + (usage.output_tokens or 0)
    if tts_chars:
        review.tts_chars = (review.tts_chars or 0) + tts_chars


init_db()

AUDIO_DIR = Path(os.environ.get("AUDIO_DIR", "./data/audio")).resolve()
# Reject still uses a short canned line — there's no conversational responder
# for "the user disagreed with the critique"; that's a decision, not a reply.
REJECT_RESPONSE_TEXT = "Acknowledged. Moving on as written."

app = FastAPI(title="doc2meeting-web")

# SessionMiddleware required by authlib for OAuth state parameter
_session_secret = os.environ.get("SESSION_SECRET_KEY", "dev-session-secret-change-me")
app.add_middleware(SessionMiddleware, secret_key=_session_secret)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Health check router (unprotected)
app.include_router(health_router)

# Auth router (unprotected — login/register/refresh/logout)
app.include_router(auth_router)

# Drive OAuth consent router (connect/callback unprotected; status/disconnect require auth)
app.include_router(drive_auth_router)

# Billing router (checkout + billing info protected; webhooks unprotected)
app.include_router(billing_router)

# Admin dashboard router (all routes require is_admin)
app.include_router(admin_router)

# Export router (structured notes)
app.include_router(export_router)

# Email inbound webhook router (unprotected — verified by signature)
app.include_router(email_router)

# Telegram bot router (webhook unprotected; setup requires admin)
app.include_router(telegram_router)


# ---------- Auth helpers for route protection ----------

def _get_user_doc(session: Session, doc_id: int, current_user: User) -> Document:
    """Load a document and verify ownership. Returns 404 if not found or not owned."""
    doc = session.get(Document, doc_id)
    if doc is None or (doc.user_id is not None and doc.user_id != current_user.id):
        raise HTTPException(404, "Document not found")
    return doc


# ---------- Filesystem tree ----------

@app.get("/api/tree")
def get_tree(current_user: User = Depends(get_current_user)) -> dict:
    return {
        "root": fs.root_dir().name,
        "root_abs": str(fs.root_dir()),
        "tree": fs.list_tree().to_dict(),
    }


@app.get("/api/files/{rel_path:path}", response_class=PlainTextResponse)
def get_file(rel_path: str, current_user: User = Depends(get_current_user)) -> str:
    try:
        return fs.read_text(rel_path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "File not found")


class ConvertBody(BaseModel):
    rel_path: str


@app.post("/api/files/convert")
def convert_file(body: ConvertBody, current_user: User = Depends(get_current_user)) -> dict:
    """Convert a .docx into a sibling `.md` file using markitdown.

    Saved as `<stem>.md` next to the source. Refuses to overwrite an existing
    file — rename the existing markdown first if you want to re-convert."""
    rel = body.rel_path.replace("\\", "/").lstrip("/")
    try:
        src = fs.resolve_rel(rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not src.is_file():
        raise HTTPException(404, "File not found")
    if src.suffix.lower() != ".docx":
        raise HTTPException(400, "Only .docx is supported")

    target = src.with_suffix(".md")
    if target.exists():
        raise HTTPException(
            409,
            f"'{target.name}' already exists — rename or delete it before re-converting.",
        )

    # Import lazily so the rest of the app starts even if markitdown is broken
    # for some reason (e.g. ONNX runtime issues on this machine).
    from markitdown import MarkItDown

    try:
        result = MarkItDown().convert(str(src))
    except Exception as e:
        raise HTTPException(500, f"Conversion failed: {e}")

    cleaned = strip_toc(result.text_content or "")
    target.write_text(cleaned, encoding="utf-8")
    return {
        "saved_rel_path": fs.to_rel(target),
        "size": target.stat().st_size,
    }


# ---------- File upload ----------

UPLOAD_ALLOWED_EXTENSIONS = {".docx", ".md", ".pdf"}
UPLOAD_MAX_SIZE = 50 * 1024 * 1024  # 50 MB
UPLOAD_MAX_BATCH = 5


@app.post("/api/documents/upload")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Upload a .docx, .md, or .pdf file. Non-markdown files are auto-converted."""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in UPLOAD_ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported file type: {ext}. Accepted: .docx, .md, .pdf",
        )

    content = await file.read()
    if len(content) > UPLOAD_MAX_SIZE:
        raise HTTPException(400, "File too large (max 50 MB)")
    if len(content) == 0:
        raise HTTPException(400, "Empty file")

    # Deduplicate filenames in ROOT_DIR
    base_name = Path(file.filename).stem
    target = fs.root_dir() / file.filename
    counter = 1
    while target.exists():
        target = fs.root_dir() / f"{base_name}_{counter}{ext}"
        counter += 1

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)

    # Convert non-markdown files to .md using markitdown
    md_rel_path: str | None = None
    if ext in (".docx", ".pdf"):
        from markitdown import MarkItDown

        try:
            result = MarkItDown().convert(str(target))
        except Exception as e:
            target.unlink(missing_ok=True)
            raise HTTPException(500, f"Conversion failed: {e}")
        md_target = target.with_suffix(".md")
        # Avoid overwriting existing .md with same name
        md_counter = 1
        while md_target.exists():
            md_target = target.with_name(f"{target.stem}_{md_counter}.md")
            md_counter += 1
        cleaned = strip_toc(result.text_content or "")
        md_target.write_text(cleaned, encoding="utf-8")
        md_rel_path = fs.to_rel(md_target)

    rel_path = md_rel_path or fs.to_rel(target)

    # Create Document record
    text = fs.read_text(rel_path)
    hash_now = fs.content_hash(text)

    # Upload to Google Drive document folder if connected
    drive_file_id: str | None = None
    doc_name = Path(rel_path).stem  # e.g. "My Report" from "My Report.md"
    storage = get_user_storage(current_user)
    if storage and hasattr(storage, "upload_to_document_folder"):
        try:
            mime = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    ".pdf": "application/pdf", ".md": "text/markdown"}.get(ext, "application/octet-stream")
            stored = await storage.upload_to_document_folder(
                doc_name, target.name, content, mime,
            )
            drive_file_id = stored.id
            _log.info("Uploaded document to Drive: %s/%s (id=%s)", doc_name, target.name, stored.id)
        except Exception:
            _log.warning("Drive upload failed for document %s", target.name, exc_info=True)

    with Session(engine) as session:
        doc = Document(
            rel_path=rel_path,
            content_hash=hash_now,
            user_id=current_user.id,
            last_opened_at=datetime.utcnow(),
            drive_file_id=drive_file_id,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)

        return {
            "id": doc.id,
            "rel_path": rel_path,
            "name": Path(rel_path).name,
            "original_name": file.filename,
            "size": len(content),
        }


# ---------- Google Drive file browser ----------


@app.get("/api/drive/browse")
async def drive_browse(
    folder_id: str = "",
    q: str = "",
    page_token: str = "",
    current_user: User = Depends(get_current_user),
) -> dict:
    """List files in the user's Google Drive for picking/importing."""
    storage = get_user_storage(current_user)
    if not storage or not hasattr(storage, "list_user_files"):
        raise HTTPException(400, "Google Drive not connected")

    try:
        return await storage.list_user_files(
            folder_id=folder_id or None,
            query=q or None,
            page_token=page_token or None,
        )
    except Exception as exc:
        _log.warning("Drive browse failed: %s", exc, exc_info=True)
        raise HTTPException(502, "Failed to list Drive files")


class DriveImportBody(BaseModel):
    file_id: str
    name: str


@app.post("/api/drive/import")
async def drive_import(
    body: DriveImportBody,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Import a file from the user's Google Drive into the library.

    Downloads the file, converts to markdown if needed, saves locally,
    and copies to the app's doc2audiobook folder on Drive.
    """
    storage = get_user_storage(current_user)
    if not storage:
        raise HTTPException(400, "Google Drive not connected")

    # Download the file from Drive
    try:
        content = await storage.download_by_id(body.file_id)
    except Exception as exc:
        _log.warning("Drive import download failed: %s", exc, exc_info=True)
        raise HTTPException(502, "Failed to download file from Drive")

    if len(content) == 0:
        raise HTTPException(400, "File is empty")
    if len(content) > UPLOAD_MAX_SIZE:
        raise HTTPException(400, "File too large (max 50 MB)")

    filename = body.name
    ext = Path(filename).suffix.lower()
    if ext not in UPLOAD_ALLOWED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported file type: {ext}. Accepted: .docx, .md, .pdf",
        )

    # Save to local filesystem (same dedup logic as upload)
    base_name = Path(filename).stem
    target = fs.root_dir() / filename
    counter = 1
    while target.exists():
        target = fs.root_dir() / f"{base_name}_{counter}{ext}"
        counter += 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)

    # Convert non-markdown files
    md_rel_path: str | None = None
    if ext in (".docx", ".pdf"):
        from markitdown import MarkItDown

        try:
            result = MarkItDown().convert(str(target))
        except Exception as e:
            target.unlink(missing_ok=True)
            raise HTTPException(500, f"Conversion failed: {e}")
        md_target = target.with_suffix(".md")
        md_counter = 1
        while md_target.exists():
            md_target = target.with_name(f"{target.stem}_{md_counter}.md")
            md_counter += 1
        cleaned = strip_toc(result.text_content or "")
        md_target.write_text(cleaned, encoding="utf-8")
        md_rel_path = fs.to_rel(md_target)

    rel_path = md_rel_path or fs.to_rel(target)

    # Create Document record
    text = fs.read_text(rel_path)
    hash_now = fs.content_hash(text)

    # Copy to app's doc2audiobook folder on Drive
    drive_file_id: str | None = None
    doc_name = Path(rel_path).stem
    if hasattr(storage, "upload_to_document_folder"):
        try:
            mime = {
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".pdf": "application/pdf",
                ".md": "text/markdown",
            }.get(ext, "application/octet-stream")
            stored = await storage.upload_to_document_folder(
                doc_name, target.name, content, mime,
            )
            drive_file_id = stored.id
            _log.info("Imported Drive file to app folder: %s/%s (id=%s)", doc_name, target.name, stored.id)
        except Exception:
            _log.warning("Drive copy failed for import %s", target.name, exc_info=True)

    with Session(engine) as session:
        doc = Document(
            rel_path=rel_path,
            content_hash=hash_now,
            user_id=current_user.id,
            last_opened_at=datetime.utcnow(),
            drive_file_id=drive_file_id,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)

        return {
            "id": doc.id,
            "rel_path": rel_path,
            "name": Path(rel_path).name,
            "original_name": filename,
            "size": len(content),
        }


# ---------- Documents ----------

class OpenBody(BaseModel):
    rel_path: str


@app.post("/api/documents/open")
def open_document(body: OpenBody, current_user: User = Depends(get_current_user)) -> dict:
    rel = body.rel_path.replace("\\", "/").lstrip("/")
    try:
        text = fs.read_text(rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "File not found")
    hash_now = fs.content_hash(text)

    # Estimate page count from sections for tier enforcement
    sections = parse_markdown(text)
    page_count = max(1, len(sections))

    with Session(engine) as session:
        # Tier enforcement: check doc and page limits before processing
        check_usage_limits(current_user, session, page_count=page_count)

        doc = session.exec(
            select(Document).where(
                Document.rel_path == rel,
                Document.user_id == current_user.id,
            )
        ).first()
        is_new = doc is None
        if is_new:
            doc = Document(rel_path=rel, content_hash=hash_now, user_id=current_user.id)
            session.add(doc)
        else:
            doc.content_hash = hash_now
            doc.last_opened_at = datetime.utcnow()
            session.add(doc)
        session.commit()
        session.refresh(doc)

        # Record usage for new document processing
        if is_new:
            record_usage(session, current_user, document_id=doc.id, page_count=page_count)

        return _serialize_document(session, doc, text)


@app.get("/api/documents")
@limiter.limit(tier_limit)
def list_documents(request: Request, current_user: User = Depends(get_current_user)) -> list[dict]:
    with Session(engine) as session:
        docs = session.exec(
            select(Document)
            .where(Document.user_id == current_user.id)
            .order_by(Document.last_opened_at.desc())
        ).all()
        out: list[dict] = []
        for d in docs:
            out.append(
                {
                    "id": d.id,
                    "rel_path": d.rel_path,
                    "name": Path(d.rel_path).name,
                    "context_paths": d.context_paths,
                    "last_opened_at": d.last_opened_at.isoformat(),
                    "on_drive": bool(d.drive_file_id),
                }
            )
        return out


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: int, current_user: User = Depends(get_current_user)) -> dict:
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        try:
            text = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            raise HTTPException(410, f"File '{doc.rel_path}' no longer exists on disk")
        # Recompute hash silently; banner is built in serializer if mismatched.
        doc.last_opened_at = datetime.utcnow()
        session.add(doc)
        session.commit()
        session.refresh(doc)
        return _serialize_document(session, doc, text)


class ContextBody(BaseModel):
    context_paths: list[str]


@app.patch("/api/documents/{doc_id}")
def patch_document(doc_id: int, body: ContextBody, current_user: User = Depends(get_current_user)) -> dict:
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        # Filter to known-good rel paths; silently drop anything invalid.
        safe: list[str] = []
        for p in body.context_paths:
            try:
                target = fs.resolve_rel(p)
                if target.is_file():
                    safe.append(fs.to_rel(target))
            except ValueError:
                continue
        doc.set_context_paths(safe)
        session.add(doc)
        session.commit()
        session.refresh(doc)
        try:
            text = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            text = ""
        return _serialize_document(session, doc, text)


# ---------- Document deletion ----------

@app.delete("/api/documents/{doc_id}")
async def delete_document(
    doc_id: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Delete a document and its associated reviews, local files, and Drive files."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)

        # Collect Drive file IDs to delete
        drive_ids_to_delete: list[str] = []
        if doc.drive_file_id:
            drive_ids_to_delete.append(doc.drive_file_id)

        reviews = session.exec(
            select(Review).where(Review.document_id == doc_id)
        ).all()
        for r in reviews:
            for field in ("narrator_drive_id", "reviewer_drive_id", "response_drive_id"):
                did = getattr(r, field, None)
                if did:
                    drive_ids_to_delete.append(did)
            session.delete(r)

        # Delete usage records
        usage_records = session.exec(
            select(UsageRecord).where(UsageRecord.document_id == doc_id)
        ).all()
        for u in usage_records:
            session.delete(u)

        # Delete user comments
        user_comments = session.exec(
            select(UserComment).where(UserComment.document_id == doc_id)
        ).all()
        for uc in user_comments:
            session.delete(uc)

        # Delete Drive files — prefer deleting the whole document folder
        doc_name = Path(doc.rel_path).stem
        storage = get_user_storage(current_user)
        if storage:
            if hasattr(storage, "delete_document_folder"):
                try:
                    await storage.delete_document_folder(doc_name)
                except Exception:
                    _log.warning("Failed to delete Drive folder %s", doc_name, exc_info=True)
            elif drive_ids_to_delete:
                for did in drive_ids_to_delete:
                    try:
                        await storage.delete_by_id(did)
                    except Exception:
                        _log.warning("Failed to delete Drive file %s", did, exc_info=True)

        # Delete local audio directory for this document
        audio_dir = AUDIO_DIR / str(doc_id)
        if audio_dir.is_dir():
            shutil.rmtree(audio_dir, ignore_errors=True)

        # Delete source file
        try:
            source_path = fs.resolve_rel(doc.rel_path)
            if source_path.is_file():
                source_path.unlink()
        except (ValueError, OSError):
            pass  # file may already be gone

        session.delete(doc)
        session.commit()

    return {"deleted": True, "id": doc_id}


# ---------- User voice comments (STT) ----------


class CommentBody(BaseModel):
    section_idx: int
    paragraph_idx: int
    text: str


@app.post("/api/documents/{doc_id}/comments")
def create_comment(
    doc_id: int,
    body: CommentBody,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Create a voice-to-text comment on a specific paragraph."""
    with Session(engine) as session:
        _get_user_doc(session, doc_id, current_user)
        comment = UserComment(
            document_id=doc_id,
            section_idx=body.section_idx,
            paragraph_idx=body.paragraph_idx,
            user_id=current_user.id,
            text=body.text,
        )
        session.add(comment)
        session.commit()
        session.refresh(comment)
        return {
            "id": comment.id,
            "document_id": comment.document_id,
            "section_idx": comment.section_idx,
            "paragraph_idx": comment.paragraph_idx,
            "text": comment.text,
            "created_at": comment.created_at.isoformat(),
        }


@app.get("/api/documents/{doc_id}/comments")
def list_comments(
    doc_id: int,
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """List all user comments for a document."""
    with Session(engine) as session:
        _get_user_doc(session, doc_id, current_user)
        comments = session.exec(
            select(UserComment)
            .where(UserComment.document_id == doc_id, UserComment.user_id == current_user.id)
            .order_by(UserComment.section_idx, UserComment.paragraph_idx, UserComment.created_at)
        ).all()
        return [
            {
                "id": c.id,
                "section_idx": c.section_idx,
                "paragraph_idx": c.paragraph_idx,
                "text": c.text,
                "created_at": c.created_at.isoformat(),
            }
            for c in comments
        ]


@app.delete("/api/documents/{doc_id}/comments/{comment_id}")
def delete_comment(
    doc_id: int,
    comment_id: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Delete a specific user comment."""
    with Session(engine) as session:
        comment = session.get(UserComment, comment_id)
        if not comment or comment.document_id != doc_id or comment.user_id != current_user.id:
            raise HTTPException(404, "Comment not found")
        session.delete(comment)
        session.commit()
        return {"deleted": True}


@app.get("/api/documents/{doc_id}/comments/export")
def export_comments(
    doc_id: int,
    current_user: User = Depends(get_current_user),
) -> PlainTextResponse:
    """Export all user comments for a document as markdown."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        comments = session.exec(
            select(UserComment)
            .where(UserComment.document_id == doc_id, UserComment.user_id == current_user.id)
            .order_by(UserComment.section_idx, UserComment.paragraph_idx, UserComment.created_at)
        ).all()

        if not comments:
            return PlainTextResponse(
                f"# Review Notes: {Path(doc.rel_path).name}\n\nNo comments recorded.\n",
                media_type="text/markdown",
            )

        # Group comments by section
        from collections import defaultdict
        by_section: dict[int, list[UserComment]] = defaultdict(list)
        for c in comments:
            by_section[c.section_idx].append(c)

        # Try to get section titles from the document
        try:
            text = fs.read_text(doc.rel_path)
            sections = parse_markdown(text)
            section_titles = {s["idx"]: s["title"] for s in sections}
        except Exception:
            section_titles = {}

        lines = [f"# Review Notes: {Path(doc.rel_path).name}\n"]
        for sec_idx in sorted(by_section.keys()):
            title = section_titles.get(sec_idx, f"Section {sec_idx + 1}")
            lines.append(f"\n## {title}\n")
            for c in by_section[sec_idx]:
                lines.append(f"- **[¶{c.paragraph_idx + 1}]** {c.text}")

        return PlainTextResponse(
            "\n".join(lines) + "\n",
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{Path(doc.rel_path).stem}_notes.md"'},
        )


# ---------- Save as next version ----------

@app.post("/api/documents/{doc_id}/save_markup")
def save_markup(doc_id: int, current_user: User = Depends(get_current_user)) -> dict:
    """Write a `<name>_markup_v<N>.md` review-notes file next to the source.

    Includes every paragraph that has a review (any status). For each:
    section reference, status, original text, reviewer comment, narrator
    response, owner note, and the proposed replacement (when present).

    Designed to be read by another human or AI agent to apply the changes
    independently of this app."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        try:
            original = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            raise HTTPException(410, f"File '{doc.rel_path}' no longer exists on disk")

        sections = parse_markdown(original)
        reviews = session.exec(
            select(Review)
            .where(Review.document_id == doc_id)
            .order_by(Review.section_idx, Review.paragraph_idx, Review.id)
        ).all()
        # Latest review per (section_idx, paragraph_idx).
        latest: dict[tuple[int, int], Review] = {}
        for r in reviews:
            latest[(r.section_idx, r.paragraph_idx)] = r

        if not latest:
            raise HTTPException(409, "No reviews to export yet")

        lines: list[str] = []
        lines.append(f"# Review markup for `{doc.rel_path}`")
        lines.append("")
        lines.append(f"- Generated: {datetime.utcnow().isoformat()}Z")
        lines.append(f"- Source content hash: `{fs.content_hash(original)}`")
        if doc.context_paths:
            lines.append("- Context documents:")
            for cp in doc.context_paths:
                lines.append(f"  - `{cp}`")
        lines.append("")
        lines.append(
            "Each block below shows one paragraph that received a review. "
            "Apply changes by replacing the **Original** text with the "
            "**Proposed replacement** in the source file, where status is "
            "*accepted*. Pending blocks need a decision; rejected blocks "
            "should be left unchanged unless you disagree with the rejection."
        )
        lines.append("")
        lines.append("---")
        lines.append("")

        # Group by section so the file reads top-to-bottom in document order.
        for s_idx, sec in enumerate(sections):
            sec_paras = split_paragraphs(sec.body)
            sec_keys = sorted(
                (k for k in latest if k[0] == s_idx),
                key=lambda k: k[1],
            )
            if not sec_keys:
                continue
            heading_prefix = "#" * min(max(sec.level, 1), 6)
            lines.append(f"{heading_prefix} Section {s_idx + 1} — {sec.title}")
            lines.append("")
            for s, p in sec_keys:
                r = latest[(s, p)]
                in_range = 0 <= p < len(sec_paras)
                original_text = sec_paras[p] if in_range else "_(paragraph index no longer aligns to source)_"
                status_label = {
                    ReviewStatus.pending: "pending",
                    ReviewStatus.accepted: "accepted",
                    ReviewStatus.rejected: "rejected",
                }[r.status]
                lines.append(f"### Paragraph {p + 1} — *{status_label}*")
                lines.append("")
                lines.append("**Original:**")
                lines.append("")
                lines.extend(_blockquote(original_text))
                lines.append("")
                if r.comment:
                    lines.append(f"**Reviewer:** {r.comment.strip()}")
                    lines.append("")
                if r.narrator_response_text:
                    lines.append(
                        f"**Narrator response:** {r.narrator_response_text.strip()}"
                    )
                    lines.append("")
                if r.user_comment:
                    lines.append(f"**Owner note:** {r.user_comment.strip()}")
                    lines.append("")
                if r.status == ReviewStatus.accepted and r.proposed_replacement:
                    lines.append("**Proposed replacement:**")
                    lines.append("")
                    lines.extend(_blockquote(r.proposed_replacement))
                    lines.append("")
                elif r.status == ReviewStatus.accepted:
                    lines.append("_Accepted but no proposed replacement was generated._")
                    lines.append("")
                elif r.status == ReviewStatus.rejected:
                    lines.append("_Rejected — leave unchanged._")
                    lines.append("")
                lines.append("---")
                lines.append("")

        content = "\n".join(lines).rstrip() + "\n"
        target = fs.next_markup_path(doc.rel_path)
        fs.save_text(target, content)
        return {
            "saved_rel_path": fs.to_rel(target),
            "saved_at": datetime.utcnow().isoformat(),
            "size": target.stat().st_size,
            "review_count": len(latest),
        }


def _blockquote(text: str) -> list[str]:
    """Render `text` as a markdown blockquote, one quoted line per source line."""
    out: list[str] = []
    for line in text.splitlines() or [""]:
        out.append(f"> {line}" if line else ">")
    return out


@app.post("/api/documents/{doc_id}/save_version")
def save_version(doc_id: int, current_user: User = Depends(get_current_user)) -> dict:
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        try:
            original = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            raise HTTPException(410, f"File '{doc.rel_path}' no longer exists on disk")

        sections = parse_markdown(original)

        # For every (section_idx, paragraph_idx) with an accepted+replacement
        # review, swap the paragraph text. Otherwise keep the original.
        reviews = session.exec(
            select(Review).where(Review.document_id == doc_id)
        ).all()
        # Map (sec_idx, p_idx) -> latest accepted replacement (last wins).
        replacements: dict[tuple[int, int], str] = {}
        for r in sorted(reviews, key=lambda x: x.id or 0):
            if (
                r.status == ReviewStatus.accepted
                and r.proposed_replacement
                and r.proposed_replacement.strip()
            ):
                replacements[(r.section_idx, r.paragraph_idx)] = r.proposed_replacement.strip()

        # Reassemble markdown.
        lines: list[str] = []
        for s_idx, sec in enumerate(sections):
            heading = "#" * sec.level
            lines.append(f"{heading} {sec.title}")
            lines.append("")
            if not sec.body.strip():
                continue
            paragraphs = split_paragraphs(sec.body)
            for p_idx, p in enumerate(paragraphs):
                lines.append(replacements.get((s_idx, p_idx), p))
                lines.append("")
        new_content = "\n".join(lines).rstrip() + "\n"

        target = fs.next_version_path(doc.rel_path)
        fs.save_text(target, new_content)
        return {
            "saved_rel_path": fs.to_rel(target),
            "saved_at": datetime.utcnow().isoformat(),
            "size": target.stat().st_size,
        }


# ---------- Reviews ----------

@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/review"
)
@limiter.limit(tier_limit)
def generate_paragraph_review(
    request: Request,
    doc_id: int,
    section_idx: int,
    paragraph_idx: int,
    persona: str = "skeptical",
    auto_accept: bool = False,
    with_response: bool = False,
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict:
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        try:
            text = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            raise HTTPException(410, "Source file gone")

        sections = parse_markdown(text)
        if not (0 <= section_idx < len(sections)):
            raise HTTPException(404, f"Section index out of range")
        sec = sections[section_idx]
        paragraphs = split_paragraphs(sec.body)
        if not (0 <= paragraph_idx < len(paragraphs)):
            raise HTTPException(404, f"Paragraph index out of range")
        paragraph = paragraphs[paragraph_idx]

        # Build rolling section history from prior paragraphs' reviews so the
        # reviewer (and responder) can see how the meeting has unfolded so far.
        history = _build_section_history(session, doc_id, section_idx, paragraphs, paragraph_idx)

        outline = _outline_from(sections)
        comment, reviewer_usage = review_paragraph(
            section_title=sec.title,
            full_section_body=sec.body,
            paragraph=paragraph,
            context_paths=doc.context_paths,
            persona=persona,
            section_history=history,
            document_outline=outline,
            current_section_idx=section_idx,
        )

        narrator_rel = None
        reviewer_rel = None
        narrator_chars = 0
        reviewer_chars = 0
        try:
            narrator_path, narrator_chars = synthesise_paragraph_narrator(
                paragraph, doc.id, section_idx, paragraph_idx
            )
            narrator_rel = relative_audio_path(narrator_path)
        except Exception:
            pass
        try:
            reviewer_path, reviewer_chars = synthesise_paragraph_reviewer(
                comment, doc.id, section_idx, paragraph_idx
            )
            reviewer_rel = relative_audio_path(reviewer_path)
        except Exception:
            pass

        review = Review(
            document_id=doc.id,
            section_idx=section_idx,
            paragraph_idx=paragraph_idx,
            persona=persona,
            comment=comment,
            narrator_audio_path=narrator_rel,
            reviewer_audio_path=reviewer_rel,
            status=ReviewStatus.pending,
        )
        _bill(review, usage=reviewer_usage, tts_chars=narrator_chars + reviewer_chars)
        session.add(review)
        session.commit()
        session.refresh(review)

        # Narrator responder runs whenever the caller wants the conversational
        # reply queued — for with-review playback, or because auto-accept needs
        # it. Either way it produces the same artifact, so we generate once.
        if with_response or auto_accept:
            _generate_narrator_response(
                session,
                review,
                doc,
                sec.title,
                paragraph,
                history,
                document_outline=outline,
                current_section_idx=section_idx,
            )
            session.refresh(review)

        if auto_accept:
            _finalize_auto_accept(
                session,
                review,
                doc,
                sec,
                paragraph,
                document_outline=outline,
                current_section_idx=section_idx,
            )
            session.refresh(review)

        _schedule_audio_uploads(background_tasks, current_user, review)
        return _serialize_review(review)


def _build_section_history(
    session: Session,
    doc_id: int,
    section_idx: int,
    paragraphs: list[str],
    up_to_paragraph_idx: int,
) -> list[SectionHistoryEntry]:
    """All paragraphs in this section before `up_to_paragraph_idx`, paired
    with their review thread (reviewer comment + narrator response + status)."""
    prior_reviews = session.exec(
        select(Review)
        .where(Review.document_id == doc_id)
        .where(Review.section_idx == section_idx)
        .where(Review.paragraph_idx < up_to_paragraph_idx)
        .order_by(Review.paragraph_idx)
    ).all()
    # Keep the latest review per paragraph_idx if the user re-reviewed one.
    latest_by_para: dict[int, Review] = {}
    for r in prior_reviews:
        latest_by_para[r.paragraph_idx] = r
    out: list[SectionHistoryEntry] = []
    for p_idx in range(up_to_paragraph_idx):
        if p_idx >= len(paragraphs):
            continue
        r = latest_by_para.get(p_idx)
        out.append(
            SectionHistoryEntry(
                paragraph_idx=p_idx,
                paragraph_text=paragraphs[p_idx],
                reviewer_comment=(r.comment if r else None),
                narrator_response=(r.narrator_response_text if r else None),
                user_comment=(r.user_comment if r else None),
                status=(r.status.value if r else "pending"),
            )
        )
    return out


def _generate_narrator_response(
    session: Session,
    review: Review,
    doc: Document,
    section_title: str,
    paragraph: str,
    history: list[SectionHistoryEntry],
    document_outline: list[tuple[int, int, str]] | None = None,
    current_section_idx: int | None = None,
) -> None:
    """Run the responder agent and TTS its reply, attaching both to the review.
    Best-effort — errors are swallowed so the review still returns to the caller."""
    try:
        response_text, responder_usage = narrator_respond(
            section_title=section_title,
            paragraph=paragraph,
            reviewer_comment=review.comment,
            context_paths=doc.context_paths,
            section_history=history,
            document_outline=document_outline,
            current_section_idx=current_section_idx,
        )
        _bill(review, usage=responder_usage)
        if response_text and response_text.strip():
            review.narrator_response_text = response_text.strip()
            try:
                response_path, response_chars = synthesise_response_audio(
                    response_text.strip(),
                    review.document_id,
                    review.section_idx,
                    review.paragraph_idx,
                )
                review.response_audio_path = relative_audio_path(response_path)
                _bill(review, tts_chars=response_chars)
            except Exception:
                review.response_audio_path = None
    except Exception:
        pass
    session.add(review)
    session.commit()


def _finalize_auto_accept(
    session: Session,
    review: Review,
    doc: Document,
    sec,
    paragraph: str,
    document_outline: list[tuple[int, int, str]] | None = None,
    current_section_idx: int | None = None,
) -> None:
    """Mark the review accepted and run the editor for a proposed replacement.
    Assumes the narrator response was already generated."""
    review.status = ReviewStatus.accepted
    review.resolved_at = datetime.utcnow()
    try:
        rewritten, _rationale, editor_usage = propose_replacement(
            section_title=sec.title,
            paragraph=paragraph,
            reviewer_comment=review.comment,
            user_comment=None,
            context_paths=doc.context_paths,
            document_outline=document_outline,
            current_section_idx=current_section_idx,
        )
        _bill(review, usage=editor_usage)
        if rewritten and rewritten.strip():
            review.proposed_replacement = rewritten.strip()
    except Exception:
        pass
    session.add(review)
    session.commit()


class ResolveBody(BaseModel):
    user_comment: str | None = None


@app.post("/api/reviews/{review_id}/accept")
@limiter.limit(tier_limit)
def accept_review(
    request: Request,
    review_id: int,
    body: ResolveBody | None = None,
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict:
    return _resolve_review(review_id, ReviewStatus.accepted,
                           (body.user_comment if body else None),
                           current_user=current_user,
                           background_tasks=background_tasks)


@app.post("/api/reviews/{review_id}/reject")
@limiter.limit(tier_limit)
def reject_review(
    request: Request,
    review_id: int,
    body: ResolveBody | None = None,
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict:
    return _resolve_review(review_id, ReviewStatus.rejected,
                           (body.user_comment if body else None),
                           REJECT_RESPONSE_TEXT,
                           current_user=current_user,
                           background_tasks=background_tasks)


def _load_paragraph(
    doc: Document, section_idx: int, paragraph_idx: int
) -> tuple[str, str, str] | None:
    """Re-parse the doc on disk and return (section_title, full_section_body,
    paragraph_text), or None if the index no longer aligns to a paragraph."""
    try:
        body = fs.read_text(doc.rel_path)
    except (FileNotFoundError, ValueError):
        return None
    sections = parse_markdown(body)
    if not (0 <= section_idx < len(sections)):
        return None
    sec = sections[section_idx]
    paragraphs = split_paragraphs(sec.body)
    if not (0 <= paragraph_idx < len(paragraphs)):
        return None
    return sec.title, sec.body, paragraphs[paragraph_idx]


def _resolve_review(
    review_id: int,
    status: ReviewStatus,
    user_comment: str | None,
    response_text: str | None = None,
    current_user: User | None = None,
    background_tasks: BackgroundTasks | None = None,
) -> dict:
    """Resolve a review (accept/reject).

    Accept: runs the editor for the proposed replacement, and runs the
    responder agent for a conversational reply if one is not already present
    (so users who manually accept an older review get a real reply, not the
    boilerplate that used to be hard-coded).

    Reject: uses the supplied `response_text` (a short canned line) for the
    response audio if none is present yet.
    """
    with Session(engine) as session:
        review = session.get(Review, review_id)
        if review is None:
            raise HTTPException(404, "Review not found")
        # Verify ownership through document
        doc = session.get(Document, review.document_id)
        if current_user and doc and doc.user_id is not None and doc.user_id != current_user.id:
            raise HTTPException(404, "Review not found")
        review.status = status
        review.user_comment = (user_comment or None)
        review.resolved_at = datetime.utcnow()
        loaded = (
            _load_paragraph(doc, review.section_idx, review.paragraph_idx)
            if doc is not None
            else None
        )

        # Re-parse once up-front so both the editor and responder paths can see
        # the full document outline. If the file's gone we just fall through
        # with no outline.
        doc_outline: list[tuple[int, int, str]] | None = None
        if doc is not None and loaded is not None:
            try:
                doc_outline = _outline_from(parse_markdown(fs.read_text(doc.rel_path)))
            except Exception:
                doc_outline = None

        if status == ReviewStatus.accepted:
            # Editor — proposed replacement (always re-runs so user edits take effect).
            if doc is not None and loaded is not None:
                sec_title, _sec_body, paragraph_text = loaded
                try:
                    rewritten, _rationale, editor_usage = propose_replacement(
                        section_title=sec_title,
                        paragraph=paragraph_text,
                        reviewer_comment=review.comment,
                        user_comment=review.user_comment,
                        context_paths=doc.context_paths,
                        document_outline=doc_outline,
                        current_section_idx=review.section_idx,
                    )
                    _bill(review, usage=editor_usage)
                    if rewritten and rewritten.strip():
                        review.proposed_replacement = rewritten.strip()
                except Exception:
                    review.proposed_replacement = None

            # Narrator responder — only if we don't already have a real reply.
            # Replaces the legacy hard-coded "Noted." path.
            if (
                doc is not None
                and loaded is not None
                and not (review.narrator_response_text and review.narrator_response_text.strip())
            ):
                sec_title, _sec_body, paragraph_text = loaded
                try:
                    text = fs.read_text(doc.rel_path)
                    sections = parse_markdown(text)
                    paragraphs = split_paragraphs(sections[review.section_idx].body)
                    history = _build_section_history(
                        session, doc.id, review.section_idx, paragraphs, review.paragraph_idx
                    )
                except Exception:
                    history = []
                # Make sure a stale boilerplate audio file doesn't get reused
                # as the "real" reply — drop the old path first so the
                # responder helper writes a fresh one.
                review.response_audio_path = None
                _generate_narrator_response(
                    session,
                    review,
                    doc,
                    sec_title,
                    paragraph_text,
                    history,
                    document_outline=doc_outline,
                    current_section_idx=review.section_idx,
                )

        # Rejected reviews still get a short canned audio reply.
        if (
            status == ReviewStatus.rejected
            and response_text
            and not review.response_audio_path
        ):
            try:
                rej_path, rej_chars = synthesise_response_audio(
                    response_text,
                    review.document_id,
                    review.section_idx,
                    review.paragraph_idx,
                )
                review.response_audio_path = relative_audio_path(rej_path)
                _bill(review, tts_chars=rej_chars)
            except Exception:
                review.response_audio_path = None

        session.add(review)
        session.commit()
        session.refresh(review)
        if background_tasks and current_user:
            _schedule_audio_uploads(background_tasks, current_user, review)
        return _serialize_review(review)


# ---------- Staged review endpoints (pipelined player) ----------

def _latest_review_for(
    session: Session, doc_id: int, section_idx: int, paragraph_idx: int
) -> Review | None:
    return session.exec(
        select(Review)
        .where(Review.document_id == doc_id)
        .where(Review.section_idx == section_idx)
        .where(Review.paragraph_idx == paragraph_idx)
        .order_by(Review.id.desc())
    ).first()


def _load_section_state(doc: Document, section_idx: int):
    """Returns (sec, paragraphs, sections) or raises HTTPException."""
    try:
        text = fs.read_text(doc.rel_path)
    except FileNotFoundError:
        raise HTTPException(410, "Source file gone")
    sections = parse_markdown(text)
    if not (0 <= section_idx < len(sections)):
        raise HTTPException(404, "Section index out of range")
    sec = sections[section_idx]
    paragraphs = split_paragraphs(sec.body)
    return sec, paragraphs, sections


def _outline_from(sections) -> list[tuple[int, int, str]]:
    """Build the (idx, level, title) outline list from parsed sections."""
    return [(i, s.level, s.title) for i, s in enumerate(sections)]


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/reviewer"
)
def stage_reviewer(
    doc_id: int,
    section_idx: int,
    paragraph_idx: int,
    persona: str = "skeptical",
    current_user: User = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> dict:
    """Stage 2: ensure a Review row with reviewer comment + reviewer TTS.

    Idempotent — returns the existing review if it already has both. Otherwise
    runs the reviewer agent (with rolling section history) and TTSes the
    comment. Also makes sure the paragraph's narrator audio exists (so the
    Review row carries the URL the player can use directly)."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        sec, paragraphs, sections = _load_section_state(doc, section_idx)
        if not (0 <= paragraph_idx < len(paragraphs)):
            raise HTTPException(404, "Paragraph index out of range")
        paragraph = paragraphs[paragraph_idx]

        existing = _latest_review_for(session, doc_id, section_idx, paragraph_idx)
        if (
            existing
            and existing.comment
            and existing.reviewer_audio_path
            and existing.narrator_audio_path
        ):
            return _serialize_review(existing)

        comment = existing.comment if (existing and existing.comment) else None
        reviewer_usage = None
        if comment is None:
            history = _build_section_history(
                session, doc_id, section_idx, paragraphs, paragraph_idx
            )
            comment, reviewer_usage = review_paragraph(
                section_title=sec.title,
                full_section_body=sec.body,
                paragraph=paragraph,
                context_paths=doc.context_paths,
                persona=persona,
                section_history=history,
                document_outline=_outline_from(sections),
                current_section_idx=section_idx,
            )

        narrator_rel = existing.narrator_audio_path if existing else None
        narrator_chars = 0
        if not narrator_rel:
            try:
                npath, narrator_chars = ensure_paragraph_narrator(
                    paragraph, doc_id, section_idx, paragraph_idx
                )
                narrator_rel = relative_audio_path(npath)
            except Exception:
                narrator_rel = None

        reviewer_rel = existing.reviewer_audio_path if existing else None
        reviewer_chars = 0
        if not reviewer_rel:
            try:
                rpath, reviewer_chars = synthesise_paragraph_reviewer(
                    comment, doc_id, section_idx, paragraph_idx
                )
                reviewer_rel = relative_audio_path(rpath)
            except Exception:
                reviewer_rel = None

        if existing is None:
            review = Review(
                document_id=doc_id,
                section_idx=section_idx,
                paragraph_idx=paragraph_idx,
                persona=persona,
                comment=comment,
                narrator_audio_path=narrator_rel,
                reviewer_audio_path=reviewer_rel,
                status=ReviewStatus.pending,
            )
        else:
            existing.comment = comment
            existing.narrator_audio_path = narrator_rel
            existing.reviewer_audio_path = reviewer_rel
            review = existing
        _bill(
            review,
            usage=reviewer_usage,
            tts_chars=narrator_chars + reviewer_chars,
        )
        session.add(review)
        session.commit()
        session.refresh(review)
        _schedule_audio_uploads(background_tasks, current_user, review)
        return _serialize_review(review)


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/response"
)
def stage_response(doc_id: int, section_idx: int, paragraph_idx: int, current_user: User = Depends(get_current_user), background_tasks: BackgroundTasks = BackgroundTasks()) -> dict:
    """Stage 3: ensure narrator response text + audio on an existing review.

    Idempotent — returns immediately if the response is already present.
    Requires the reviewer stage to have run first (so we know the review)."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        review = _latest_review_for(session, doc_id, section_idx, paragraph_idx)
        if review is None:
            raise HTTPException(409, "Reviewer stage must run before response stage")
        if review.narrator_response_text and review.response_audio_path:
            return _serialize_review(review)

        sec, paragraphs, sections = _load_section_state(doc, section_idx)
        if not (0 <= paragraph_idx < len(paragraphs)):
            raise HTTPException(404, "Paragraph index out of range")
        paragraph = paragraphs[paragraph_idx]
        history = _build_section_history(
            session, doc_id, section_idx, paragraphs, paragraph_idx
        )
        _generate_narrator_response(
            session,
            review,
            doc,
            sec.title,
            paragraph,
            history,
            document_outline=_outline_from(sections),
            current_section_idx=section_idx,
        )
        session.refresh(review)
        _schedule_audio_uploads(background_tasks, current_user, review)
        return _serialize_review(review)


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/clear"
)
def clear_paragraph_reviews(
    doc_id: int, section_idx: int, paragraph_idx: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Delete every review row for one paragraph. The on-disk audio files
    aren't touched — they're content-addressed and will be re-used on the
    next regeneration if the paragraph text is unchanged."""
    with Session(engine) as session:
        _get_user_doc(session, doc_id, current_user)
        reviews = session.exec(
            select(Review)
            .where(Review.document_id == doc_id)
            .where(Review.section_idx == section_idx)
            .where(Review.paragraph_idx == paragraph_idx)
        ).all()
        deleted = len(reviews)
        for r in reviews:
            session.delete(r)
        session.commit()
        return {"deleted": deleted}


# ---------- Voice comments (Whisper STT) ----------

_WHISPER_MODEL = os.environ.get("OPENAI_WHISPER_MODEL", "whisper-1")


@app.post("/api/transcribe")
@limiter.limit(tier_limit)
async def transcribe(request: Request, audio: UploadFile = File(...), current_user: User = Depends(get_current_user)) -> dict:
    """Plain audio → text via Whisper. Returns just `{ text }` — doesn't save
    anywhere. Used by the per-paragraph mic-note button so the user can
    transcribe, then edit, then choose what to do with the text."""
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio payload")
    buf = io.BytesIO(audio_bytes)
    buf.name = audio.filename or "note.webm"
    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        transcript = client.audio.transcriptions.create(
            model=_WHISPER_MODEL,
            file=buf,
        ).text
    except Exception as e:
        raise HTTPException(500, f"Transcription failed: {e}")
    return {"text": (transcript or "").strip()}


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/voice_comment"
)
async def voice_comment(
    doc_id: int,
    section_idx: int,
    paragraph_idx: int,
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Transcribe a short voice clip via Whisper and append it to the
    paragraph's user_comment. Creates a stub review row if none exists yet —
    the pump's reviewer stage will fill in the missing fields when it runs.

    Returns the transcript + the updated review."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)

        # Validate paragraph index against the current parse.
        sec, paragraphs, _sections = _load_section_state(doc, section_idx)
        if not (0 <= paragraph_idx < len(paragraphs)):
            raise HTTPException(404, "Paragraph index out of range")

        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(400, "Empty audio payload")

        # OpenAI client accepts a file-like with a .name attribute.
        buf = io.BytesIO(audio_bytes)
        buf.name = audio.filename or "comment.webm"
        try:
            client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
            transcript = client.audio.transcriptions.create(
                model=_WHISPER_MODEL,
                file=buf,
            ).text
        except Exception as e:
            raise HTTPException(500, f"Transcription failed: {e}")
        transcript = (transcript or "").strip()

        if not transcript:
            return {"transcript": "", "review": None}

        review = _latest_review_for(session, doc_id, section_idx, paragraph_idx)
        if review is None:
            # Stub — reviewer stage will overwrite the empty `comment` later.
            review = Review(
                document_id=doc_id,
                section_idx=section_idx,
                paragraph_idx=paragraph_idx,
                persona="skeptical",
                comment="",
                status=ReviewStatus.pending,
            )

        existing = (review.user_comment or "").strip()
        review.user_comment = (
            f"{existing} {transcript}".strip() if existing else transcript
        )
        session.add(review)
        session.commit()
        session.refresh(review)

        return {
            "transcript": transcript,
            "review": _serialize_review(review),
        }


# ---------- Narrator-only TTS (Play-all mode) ----------

@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/narrator"
)
def get_paragraph_narrator(doc_id: int, section_idx: int, paragraph_idx: int, background_tasks: BackgroundTasks = BackgroundTasks(), current_user: User = Depends(get_current_user)) -> dict:
    """Ensure narrator audio exists for one paragraph and return its URL.
    Idempotent — re-uses the cached file when the paragraph text is unchanged.
    Schedules a background upload to Google Drive when connected."""
    with Session(engine) as session:
        doc = _get_user_doc(session, doc_id, current_user)
        try:
            text = fs.read_text(doc.rel_path)
        except FileNotFoundError:
            raise HTTPException(410, "Source file gone")

        sections = parse_markdown(text)
        if not (0 <= section_idx < len(sections)):
            raise HTTPException(404, "Section index out of range")
        paragraphs = split_paragraphs(sections[section_idx].body)
        if not (0 <= paragraph_idx < len(paragraphs)):
            raise HTTPException(404, "Paragraph index out of range")

        # Check if a review already has this narrator audio on Drive
        existing = _latest_review_for(session, doc_id, section_idx, paragraph_idx)
        if existing and existing.narrator_audio_path and existing.narrator_drive_id:
            return {"narrator_audio_url": f"/audio/{existing.narrator_audio_path}"}

        try:
            path, _chars = ensure_paragraph_narrator(
                paragraphs[paragraph_idx], doc_id, section_idx, paragraph_idx
            )
        except Exception as e:
            raise HTTPException(500, f"TTS failed: {e}")

        rel = relative_audio_path(path)

        # Persist the narrator audio path on the review record so Drive
        # upload can find it.  Create a minimal review if none exists yet.
        review = existing
        if review:
            if review.narrator_audio_path != rel:
                review.narrator_audio_path = rel
                review.narrator_drive_id = None  # reset so re-upload triggers
        else:
            review = Review(
                document_id=doc_id,
                section_idx=section_idx,
                paragraph_idx=paragraph_idx,
                comment="",
                narrator_audio_path=rel,
            )
        session.add(review)
        session.commit()
        session.refresh(review)

        _schedule_audio_uploads(background_tasks, current_user, review)

        return {"narrator_audio_url": f"/audio/{rel}"}


# ---------- App settings ----------

# Built-in OpenAI TTS voice catalogue + supported TTS models. Exposed via
# GET /api/settings so the frontend dropdowns stay in sync with the backend.
OPENAI_TTS_VOICES: list[str] = [
    "alloy", "ash", "ballad", "coral", "echo", "fable",
    "onyx", "nova", "sage", "shimmer", "verse", "cedar", "marin",
]
OPENAI_TTS_MODELS: list[str] = ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]
REVIEWER_PERSONAS: list[str] = ["skeptical", "summary", "newcomer"]


def _serialize_settings(s: AppSettings) -> dict:
    return {
        "narrator_voice": s.narrator_voice,
        "reviewer_voice": s.reviewer_voice,
        "narrator_instructions": s.narrator_instructions,
        "reviewer_instructions": s.reviewer_instructions,
        "responder_instructions": s.responder_instructions,
        "default_persona": s.default_persona,
        "tts_model": s.tts_model,
        "available_voices": OPENAI_TTS_VOICES,
        "available_tts_models": OPENAI_TTS_MODELS,
        "available_personas": REVIEWER_PERSONAS,
    }


@app.get("/api/settings")
def get_settings(current_user: User = Depends(get_current_user)) -> dict:
    return _serialize_settings(get_current_settings())


class SettingsPatch(BaseModel):
    narrator_voice: str | None = None
    reviewer_voice: str | None = None
    narrator_instructions: str | None = None
    reviewer_instructions: str | None = None
    responder_instructions: str | None = None
    default_persona: str | None = None
    tts_model: str | None = None


@app.patch("/api/settings")
def patch_settings(body: SettingsPatch, current_user: User = Depends(get_current_user)) -> dict:
    patch = body.model_dump(exclude_unset=True)
    # Validate enumerated fields up-front so we fail loudly rather than write a
    # bad voice/model that would then break the next TTS call.
    if "narrator_voice" in patch and patch["narrator_voice"] not in OPENAI_TTS_VOICES:
        raise HTTPException(400, f"Unknown narrator_voice '{patch['narrator_voice']}'")
    if "reviewer_voice" in patch and patch["reviewer_voice"] not in OPENAI_TTS_VOICES:
        raise HTTPException(400, f"Unknown reviewer_voice '{patch['reviewer_voice']}'")
    if "tts_model" in patch and patch["tts_model"] not in OPENAI_TTS_MODELS:
        raise HTTPException(400, f"Unknown tts_model '{patch['tts_model']}'")
    if "default_persona" in patch and patch["default_persona"] not in REVIEWER_PERSONAS:
        raise HTTPException(400, f"Unknown default_persona '{patch['default_persona']}'")

    with Session(engine) as session:
        s = session.exec(select(AppSettings).limit(1)).first()
        if s is None:
            s = AppSettings()
        for k, v in patch.items():
            setattr(s, k, v)
        session.add(s)
        session.commit()
        session.refresh(s)
        return _serialize_settings(s)


# ---------- Audio → Drive background upload ----------

async def _upload_audio_to_drive(
    user_id: str,
    review_id: int,
    audio_rel_path: str,
    drive_id_field: str,
    delete_local: bool = True,
) -> None:
    """Background task: upload an audio file to Drive and record its file ID.

    *drive_id_field* is the Review column to store the Drive ID in
    (``narrator_drive_id``, ``reviewer_drive_id``, or ``response_drive_id``).

    Audio is uploaded into the per-document folder: ``doc2audiobook/<doc_name>/``.
    Narrator audio (content-hash-named) is kept locally as a cache; reviewer
    and response audio (UUID-named, never re-checked) are deleted after upload.
    """
    try:
        with Session(engine) as session:
            user = session.get(User, user_id)
            if not user:
                return
            storage = get_user_storage(user)
            if not storage:
                return
            local = (AUDIO_DIR / audio_rel_path).resolve()
            if not local.is_file():
                return
            data = local.read_bytes()
            audio_filename = Path(audio_rel_path).name

            # Upload into per-document folder if storage supports it
            if hasattr(storage, "upload_to_document_folder"):
                review = session.get(Review, review_id)
                doc = session.get(Document, review.document_id) if review else None
                doc_name = Path(doc.rel_path).stem if doc else "unknown"
                stored = await storage.upload_to_document_folder(
                    doc_name, audio_filename, data, "audio/mpeg",
                )
            else:
                stored = await storage.upload_file(
                    f"audio/{audio_rel_path}", data, "audio/mpeg",
                )

            review = session.get(Review, review_id)
            if review:
                setattr(review, drive_id_field, stored.id)
                session.add(review)
                session.commit()
            _log.info("Uploaded audio to Drive: %s → %s", audio_rel_path, stored.id)
            # Delete local copy for non-narrator audio to save disk
            if delete_local:
                local.unlink(missing_ok=True)
    except Exception:
        _log.warning("Drive audio upload failed: %s", audio_rel_path, exc_info=True)


def _schedule_audio_uploads(
    background_tasks: BackgroundTasks,
    user: User,
    review: Review,
) -> None:
    """Schedule background Drive uploads for all audio files on a review."""
    if not get_user_storage(user):
        return
    for path_field, id_field, keep_local in [
        ("narrator_audio_path", "narrator_drive_id", True),
        ("reviewer_audio_path", "reviewer_drive_id", False),
        ("response_audio_path", "response_drive_id", False),
    ]:
        rel = getattr(review, path_field)
        existing_id = getattr(review, id_field)
        if rel and not existing_id:
            background_tasks.add_task(
                _upload_audio_to_drive,
                user.id,
                review.id,
                rel,
                id_field,
                not keep_local,
            )


def _lookup_audio_drive_id(rel_path: str) -> tuple[str | None, User | None]:
    """Find the Drive file ID and owning user for an audio rel_path."""
    with Session(engine) as session:
        review = session.exec(
            select(Review).where(
                or_(
                    Review.narrator_audio_path == rel_path,
                    Review.reviewer_audio_path == rel_path,
                    Review.response_audio_path == rel_path,
                )
            )
        ).first()
        if not review:
            return None, None
        # Determine which drive ID matches
        if review.narrator_audio_path == rel_path and review.narrator_drive_id:
            drive_id = review.narrator_drive_id
        elif review.reviewer_audio_path == rel_path and review.reviewer_drive_id:
            drive_id = review.reviewer_drive_id
        elif review.response_audio_path == rel_path and review.response_drive_id:
            drive_id = review.response_drive_id
        else:
            return None, None
        doc = session.get(Document, review.document_id)
        user = session.get(User, doc.user_id) if doc and doc.user_id else None
        return drive_id, user


# ---------- Audio serving ----------

@app.get("/audio/{rel_path:path}")
async def serve_audio(rel_path: str):
    target = (AUDIO_DIR / rel_path).resolve()
    if AUDIO_DIR not in target.parents and target != AUDIO_DIR:
        raise HTTPException(400, "Invalid path")
    if target.is_file():
        return FileResponse(target, media_type="audio/mpeg")

    # Fallback: fetch from Google Drive if the file was uploaded there
    drive_id, user = _lookup_audio_drive_id(rel_path)
    if not drive_id or not user:
        raise HTTPException(404, "Audio not found")
    storage = get_user_storage(user)
    if not storage:
        raise HTTPException(404, "Audio not found")
    try:
        data = await storage.download_by_id(drive_id)
    except Exception:
        _log.warning("Drive download failed for %s (id=%s)", rel_path, drive_id, exc_info=True)
        raise HTTPException(502, "Failed to fetch audio from cloud storage")
    # Cache locally so subsequent plays don't hit Drive again
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return FileResponse(target, media_type="audio/mpeg")


# ---------- Serializers ----------

def _audio_url(p: str | None) -> str | None:
    return f"/audio/{p}" if p else None


def _serialize_document(session: Session, doc: Document, body_text: str) -> dict:
    sections_parsed = parse_markdown(body_text)
    current_hash = fs.content_hash(body_text)

    reviews = session.exec(
        select(Review).where(Review.document_id == doc.id).order_by(Review.id)
    ).all()

    # Build per-section serialized output; review_count etc. computed across all paras.
    sections_out: list[dict] = []
    used_review_ids: set[int] = set()
    for s_idx, sec in enumerate(sections_parsed):
        paragraphs = split_paragraphs(sec.body)
        sec_reviews = [r for r in reviews if r.section_idx == s_idx]
        # Reviews for valid paragraph indices only; the rest become "stale".
        live_reviews = [r for r in sec_reviews if 0 <= r.paragraph_idx < len(paragraphs)]
        used_review_ids.update(r.id for r in live_reviews)
        accepted = sum(1 for r in live_reviews if r.status == ReviewStatus.accepted)
        rejected = sum(1 for r in live_reviews if r.status == ReviewStatus.rejected)
        sections_out.append(
            {
                "idx": s_idx,
                "level": sec.level,
                "title": sec.title,
                "body": sec.body,
                "paragraphs": paragraphs,
                "full_path": sec.full_path or sec.title,
                "review_count": len(live_reviews),
                "reviewed": len(live_reviews) > 0,
                "accepted_count": accepted,
                "rejected_count": rejected,
                "reviews": [_serialize_review(r) for r in live_reviews],
            }
        )

    stale_count = len([r for r in reviews if r.id not in used_review_ids])
    structure_changed = doc.content_hash != current_hash

    # Document-level cost rollup — includes orphaned/stale reviews too, since
    # we paid for those tokens regardless of whether they still align to a
    # paragraph.
    total_cost = sum(
        cost_usd(r.llm_input_tokens or 0, r.llm_output_tokens or 0, r.tts_chars or 0)
        for r in reviews
    )

    return {
        "id": doc.id,
        "rel_path": doc.rel_path,
        "name": Path(doc.rel_path).name,
        "content_hash": current_hash,
        "stored_hash": doc.content_hash,
        "context_paths": doc.context_paths,
        "section_count": len(sections_out),
        "stale_review_count": stale_count,
        "structure_changed": structure_changed,
        "sections": sections_out,
        "total_cost_usd": round(total_cost, 4),
    }


def _serialize_review(review: Review) -> dict:
    return {
        "id": review.id,
        "document_id": review.document_id,
        "section_idx": review.section_idx,
        "paragraph_idx": review.paragraph_idx,
        "persona": review.persona,
        "comment": review.comment,
        "user_comment": review.user_comment,
        "proposed_replacement": review.proposed_replacement,
        "narrator_response_text": review.narrator_response_text,
        "narrator_audio_url": _audio_url(review.narrator_audio_path),
        "reviewer_audio_url": _audio_url(review.reviewer_audio_path),
        "response_audio_url": _audio_url(review.response_audio_path),
        "status": review.status.value,
        "created_at": review.created_at.isoformat(),
        "resolved_at": review.resolved_at.isoformat() if review.resolved_at else None,
        "llm_input_tokens": review.llm_input_tokens or 0,
        "llm_output_tokens": review.llm_output_tokens or 0,
        "tts_chars": review.tts_chars or 0,
        "cost_usd": round(
            cost_usd(
                review.llm_input_tokens or 0,
                review.llm_output_tokens or 0,
                review.tts_chars or 0,
            ),
            6,
        ),
    }
