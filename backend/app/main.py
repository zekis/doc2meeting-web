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

import io
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from openai import OpenAI

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from . import fs
from .db import engine, init_db
from .models import AppSettings, Document, Review, ReviewStatus
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

app.add_middleware(
    CORSMiddleware,
    # Dev / Tailscale: accept any origin. We don't use cookies, so
    # `allow_credentials=False` keeps us compatible with the wildcard.
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Filesystem tree ----------

@app.get("/api/tree")
def get_tree() -> dict:
    return {
        "root": fs.root_dir().name,
        "root_abs": str(fs.root_dir()),
        "tree": fs.list_tree().to_dict(),
    }


@app.get("/api/files/{rel_path:path}", response_class=PlainTextResponse)
def get_file(rel_path: str) -> str:
    try:
        return fs.read_text(rel_path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "File not found")


class ConvertBody(BaseModel):
    rel_path: str


@app.post("/api/files/convert")
def convert_file(body: ConvertBody) -> dict:
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


# ---------- Documents ----------

class OpenBody(BaseModel):
    rel_path: str


@app.post("/api/documents/open")
def open_document(body: OpenBody) -> dict:
    rel = body.rel_path.replace("\\", "/").lstrip("/")
    try:
        text = fs.read_text(rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "File not found")
    hash_now = fs.content_hash(text)

    with Session(engine) as session:
        doc = session.exec(select(Document).where(Document.rel_path == rel)).first()
        if doc is None:
            doc = Document(rel_path=rel, content_hash=hash_now)
            session.add(doc)
        else:
            doc.content_hash = hash_now
            doc.last_opened_at = datetime.utcnow()
            session.add(doc)
        session.commit()
        session.refresh(doc)
        return _serialize_document(session, doc, text)


@app.get("/api/documents")
def list_documents() -> list[dict]:
    with Session(engine) as session:
        docs = session.exec(
            select(Document).order_by(Document.last_opened_at.desc())
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
                }
            )
        return out


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: int) -> dict:
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
def patch_document(doc_id: int, body: ContextBody) -> dict:
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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


# ---------- Save as next version ----------

@app.post("/api/documents/{doc_id}/save_markup")
def save_markup(doc_id: int) -> dict:
    """Write a `<name>_markup_v<N>.md` review-notes file next to the source.

    Includes every paragraph that has a review (any status). For each:
    section reference, status, original text, reviewer comment, narrator
    response, owner note, and the proposed replacement (when present).

    Designed to be read by another human or AI agent to apply the changes
    independently of this app."""
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
def save_version(doc_id: int) -> dict:
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
def generate_paragraph_review(
    doc_id: int,
    section_idx: int,
    paragraph_idx: int,
    persona: str = "skeptical",
    auto_accept: bool = False,
    with_response: bool = False,
) -> dict:
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
def accept_review(review_id: int, body: ResolveBody | None = None) -> dict:
    return _resolve_review(review_id, ReviewStatus.accepted,
                           (body.user_comment if body else None))


@app.post("/api/reviews/{review_id}/reject")
def reject_review(review_id: int, body: ResolveBody | None = None) -> dict:
    return _resolve_review(review_id, ReviewStatus.rejected,
                           (body.user_comment if body else None),
                           REJECT_RESPONSE_TEXT)


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
        review.status = status
        review.user_comment = (user_comment or None)
        review.resolved_at = datetime.utcnow()

        doc = session.get(Document, review.document_id)
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
) -> dict:
    """Stage 2: ensure a Review row with reviewer comment + reviewer TTS.

    Idempotent — returns the existing review if it already has both. Otherwise
    runs the reviewer agent (with rolling section history) and TTSes the
    comment. Also makes sure the paragraph's narrator audio exists (so the
    Review row carries the URL the player can use directly)."""
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
        return _serialize_review(review)


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/response"
)
def stage_response(doc_id: int, section_idx: int, paragraph_idx: int) -> dict:
    """Stage 3: ensure narrator response text + audio on an existing review.

    Idempotent — returns immediately if the response is already present.
    Requires the reviewer stage to have run first (so we know the review)."""
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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
        return _serialize_review(review)


@app.post(
    "/api/documents/{doc_id}/sections/{section_idx}/paragraphs/{paragraph_idx}/clear"
)
def clear_paragraph_reviews(
    doc_id: int, section_idx: int, paragraph_idx: int
) -> dict:
    """Delete every review row for one paragraph. The on-disk audio files
    aren't touched — they're content-addressed and will be re-used on the
    next regeneration if the paragraph text is unchanged."""
    with Session(engine) as session:
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
async def transcribe(audio: UploadFile = File(...)) -> dict:
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
) -> dict:
    """Transcribe a short voice clip via Whisper and append it to the
    paragraph's user_comment. Creates a stub review row if none exists yet —
    the pump's reviewer stage will fill in the missing fields when it runs.

    Returns the transcript + the updated review."""
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")

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
def get_paragraph_narrator(doc_id: int, section_idx: int, paragraph_idx: int) -> dict:
    """Ensure narrator audio exists for one paragraph and return its URL.
    Idempotent — re-uses the cached file when the paragraph text is unchanged."""
    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found")
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

        try:
            path, _chars = ensure_paragraph_narrator(
                paragraphs[paragraph_idx], doc_id, section_idx, paragraph_idx
            )
        except Exception as e:
            raise HTTPException(500, f"TTS failed: {e}")
        return {"narrator_audio_url": f"/audio/{relative_audio_path(path)}"}


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
def get_settings() -> dict:
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
def patch_settings(body: SettingsPatch) -> dict:
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


# ---------- Audio serving ----------

@app.get("/audio/{rel_path:path}")
def serve_audio(rel_path: str):
    target = (AUDIO_DIR / rel_path).resolve()
    if AUDIO_DIR not in target.parents and target != AUDIO_DIR:
        raise HTTPException(400, "Invalid path")
    if not target.is_file():
        raise HTTPException(404, "Audio not found")
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
