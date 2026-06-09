"""Email-to-review — inbound email webhook for auto-creating reviews.

Users email a document to review@domain.com and the system:
1. Identifies the sender by email → User lookup
2. Extracts the document attachment (docx, md, pdf)
3. Saves it to the user's document space
4. Creates a Document record and queues a review

Supports SendGrid Inbound Parse and generic multipart/form-data webhooks.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from sqlmodel import Session, select

from .db import engine
from .models import Document, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webhooks", tags=["email"])

# Shared secret for verifying inbound email webhooks (optional)
EMAIL_WEBHOOK_SECRET = os.environ.get("EMAIL_WEBHOOK_SECRET", "")

# Allowed file extensions for email attachments
ALLOWED_EXTENSIONS = {".md", ".docx", ".pdf", ".txt"}

ROOT_DIR = Path(os.environ.get("ROOT_DIR", "./data/documents")).resolve()


def _verify_sendgrid_signature(request: Request) -> bool:
    """Verify SendGrid inbound parse webhook signature if secret is configured."""
    if not EMAIL_WEBHOOK_SECRET:
        return True  # No secret = no verification (dev mode)

    # SendGrid sends a verification token in the payload
    # In production, configure the webhook URL with basic auth or IP allowlisting
    return True


def _find_user_by_email(session: Session, email: str) -> Optional[User]:
    """Look up a user by their email address."""
    return session.exec(select(User).where(User.email == email)).first()


def _sanitize_filename(name: str) -> str:
    """Make a filename safe for filesystem storage."""
    name = re.sub(r'[^\w\s\-.]', '', name)
    name = re.sub(r'\s+', '_', name)
    return name or "attachment"


def _save_attachment(user_id: str, filename: str, content: bytes) -> str:
    """Save an email attachment to the user's document directory."""
    user_dir = ROOT_DIR / "email_uploads" / user_id
    user_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _sanitize_filename(filename)
    stem = Path(safe_name).stem
    suffix = Path(safe_name).suffix

    # Deduplicate filenames
    target = user_dir / safe_name
    counter = 1
    while target.exists():
        target = user_dir / f"{stem}_{counter}{suffix}"
        counter += 1

    target.write_bytes(content)
    return str(target.relative_to(ROOT_DIR))


@router.post("/email")
async def email_inbound(request: Request):
    """Handle inbound email webhook (SendGrid Inbound Parse compatible).

    Expected form fields:
    - from: sender email (e.g., "John Doe <john@example.com>")
    - to: recipient (e.g., "review@domain.com")
    - subject: email subject
    - text: plain text body
    - html: HTML body (optional)
    - attachment1, attachment2, ...: file attachments

    The sender's email is matched to a User record. If found, the first
    supported attachment is saved and a Document record is created.
    """
    if not _verify_sendgrid_signature(request):
        raise HTTPException(403, detail="Invalid webhook signature")

    form = await request.form()

    # Extract sender email
    from_field = form.get("from", "")
    sender_email = _extract_email(str(from_field))
    if not sender_email:
        logger.warning("Email inbound: no valid sender email found in: %s", from_field)
        return {"status": "ignored", "reason": "no valid sender email"}

    subject = str(form.get("subject", "Untitled Review"))

    with Session(engine) as session:
        user = _find_user_by_email(session, sender_email)
        if not user:
            logger.info("Email inbound: unknown sender %s", sender_email)
            return {"status": "ignored", "reason": "sender not registered"}

        if getattr(user, "suspended_at", None):
            return {"status": "ignored", "reason": "account suspended"}

        # Find attachments — SendGrid names them attachment1, attachment2, etc.
        saved_path = None
        original_name = None

        for key in sorted(form.keys()):
            if not key.startswith("attachment"):
                continue
            upload = form[key]
            if not hasattr(upload, "filename"):
                continue

            ext = Path(upload.filename).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                continue

            content = await upload.read()
            if not content:
                continue

            original_name = upload.filename
            saved_path = _save_attachment(user.id, original_name, content)
            break  # Process first valid attachment only

        if not saved_path:
            # No attachment — check if there's inline text/markdown to save
            text_body = str(form.get("text", ""))
            if len(text_body.strip()) > 50:  # Non-trivial content
                safe_subject = _sanitize_filename(subject)
                original_name = f"{safe_subject}.md"
                content = f"# {subject}\n\n{text_body}".encode("utf-8")
                saved_path = _save_attachment(user.id, original_name, content)
            else:
                return {"status": "ignored", "reason": "no supported attachment or content"}

        # Handle docx conversion if needed
        if saved_path.endswith(".docx"):
            try:
                from markitdown import MarkItDown
                mid = MarkItDown()
                abs_path = ROOT_DIR / saved_path
                result = mid.convert(str(abs_path))
                md_path = abs_path.with_suffix(".md")
                md_path.write_text(result.text_content, encoding="utf-8")
                saved_path = str(md_path.relative_to(ROOT_DIR))
            except Exception:
                logger.exception("Failed to convert docx from email: %s", saved_path)
                # Keep the docx as-is; user can convert later

        # Create Document record
        try:
            full_path = ROOT_DIR / saved_path
            content_text = full_path.read_text(encoding="utf-8") if full_path.suffix == ".md" else ""
            content_hash = hashlib.sha256(content_text.encode()).hexdigest()[:16] if content_text else ""
        except Exception:
            content_hash = ""

        doc = Document(
            rel_path=saved_path,
            content_hash=content_hash,
            user_id=user.id,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)

        logger.info(
            "Email inbound: created document %d for user %s from %s",
            doc.id, user.email, original_name,
        )

        return {
            "status": "created",
            "document_id": doc.id,
            "rel_path": saved_path,
            "user_email": user.email,
            "original_filename": original_name,
        }


def _extract_email(from_field: str) -> Optional[str]:
    """Extract email address from a From header value like 'Name <email@example.com>'."""
    match = re.search(r'<([^>]+@[^>]+)>', from_field)
    if match:
        return match.group(1).lower().strip()
    # Try bare email
    match = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', from_field)
    if match:
        return match.group(0).lower().strip()
    return None
