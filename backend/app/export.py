"""Export review as structured notes — clean markdown summary or JSON.

Provides both /api/documents/{id}/export/notes (JSON) and enhances the
existing save_markup endpoint by also being callable as an API for
programmatic consumers (Telegram bot, API tier users).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from . import fs
from .db import engine, get_session
from .middleware import get_current_user
from .models import Document, Review, ReviewStatus, User
from .pipeline import parse_markdown, split_paragraphs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["export"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ReviewNote(BaseModel):
    section_idx: int
    section_title: str
    paragraph_idx: int
    status: str
    original_text: str
    reviewer_comment: str
    narrator_response: Optional[str]
    user_comment: Optional[str]
    proposed_replacement: Optional[str]


class ExportNotesResponse(BaseModel):
    document_id: int
    document_path: str
    exported_at: str
    total_reviews: int
    accepted: int
    rejected: int
    pending: int
    notes: list[ReviewNote]
    markdown: str


# ---------------------------------------------------------------------------
# Export endpoint
# ---------------------------------------------------------------------------

@router.get("/documents/{doc_id}/export/notes", response_model=ExportNotesResponse)
async def export_structured_notes(
    doc_id: int,
    format: str = Query("json", regex="^(json|markdown)$"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Export review as structured notes — JSON with embedded markdown.

    Returns a clean summary of all reviews on a document with:
    - Section and paragraph references
    - Status (accepted/rejected/pending)
    - Original text, reviewer comment, narrator response
    - Proposed replacements for accepted reviews
    - A pre-rendered markdown summary
    """
    doc = session.get(Document, doc_id)
    if not doc or (doc.user_id and doc.user_id != user.id):
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

    # Latest review per (section_idx, paragraph_idx)
    latest: dict[tuple[int, int], Review] = {}
    for r in reviews:
        latest[(r.section_idx, r.paragraph_idx)] = r

    if not latest:
        raise HTTPException(409, "No reviews to export yet")

    notes: list[ReviewNote] = []
    accepted = rejected = pending = 0
    md_lines: list[str] = []

    md_lines.append(f"# Review Notes: `{doc.rel_path}`\n")
    md_lines.append(f"*Exported: {datetime.utcnow().isoformat()}Z*\n")
    md_lines.append("---\n")

    for s_idx, sec in enumerate(sections):
        sec_paras = split_paragraphs(sec.body)
        sec_keys = sorted(
            (k for k in latest if k[0] == s_idx),
            key=lambda k: k[1],
        )
        if not sec_keys:
            continue

        heading = f"## {sec.title}\n"
        md_lines.append(heading)

        for s, p in sec_keys:
            r = latest[(s, p)]
            in_range = 0 <= p < len(sec_paras)
            original_text = sec_paras[p] if in_range else "(paragraph out of range)"

            status_str = r.status.value if hasattr(r.status, "value") else str(r.status)

            if status_str == "accepted":
                accepted += 1
            elif status_str == "rejected":
                rejected += 1
            else:
                pending += 1

            note = ReviewNote(
                section_idx=s_idx,
                section_title=sec.title,
                paragraph_idx=p,
                status=status_str,
                original_text=original_text,
                reviewer_comment=r.comment or "",
                narrator_response=r.narrator_response_text,
                user_comment=r.user_comment,
                proposed_replacement=r.proposed_replacement if r.status == ReviewStatus.accepted else None,
            )
            notes.append(note)

            # Build markdown
            status_icon = {"accepted": "✅", "rejected": "❌", "pending": "⏳"}.get(status_str, "•")
            md_lines.append(f"### {status_icon} Paragraph {p + 1} — *{status_str}*\n")
            md_lines.append(f"**Original:** {original_text[:200]}{'...' if len(original_text) > 200 else ''}\n")
            if r.comment:
                md_lines.append(f"**Reviewer:** {r.comment.strip()}\n")
            if r.narrator_response_text:
                md_lines.append(f"**Response:** {r.narrator_response_text.strip()}\n")
            if r.user_comment:
                md_lines.append(f"**Note:** {r.user_comment.strip()}\n")
            if r.status == ReviewStatus.accepted and r.proposed_replacement:
                md_lines.append(f"**Replacement:** {r.proposed_replacement.strip()}\n")
            md_lines.append("")

    return ExportNotesResponse(
        document_id=doc.id,
        document_path=doc.rel_path,
        exported_at=datetime.utcnow().isoformat() + "Z",
        total_reviews=len(notes),
        accepted=accepted,
        rejected=rejected,
        pending=pending,
        notes=notes,
        markdown="\n".join(md_lines),
    )
