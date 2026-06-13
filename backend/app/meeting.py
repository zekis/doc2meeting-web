"""Virtual Meeting — AI-facilitated document review conversations.

The user starts a meeting on a document. An AI agent reads paragraphs aloud,
responds to user questions/comments, and navigates the document on request.
All dialogue is stored as MeetingMessage rows for note export.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

from agents import Agent, Runner
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .db import engine
from .middleware import get_current_user
from .models import Document, MeetingMessage, MeetingSession, User
from .pipeline import (
    get_current_settings,
    parse_markdown,
    relative_audio_path,
    split_paragraphs,
    synthesise_response_audio,
)
from . import fs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

_MEETING_MODEL = os.environ.get("OPENAI_MEETING_MODEL", "gpt-4o")


# --------------- Pydantic models ---------------

class MeetingResponse(BaseModel):
    """Structured output from the meeting agent."""
    reply: str = Field(..., description="Conversational reply to the user (will be spoken aloud via TTS)")
    tool_action: Optional[str] = Field(
        None,
        description=(
            "Navigation action for the frontend. "
            "One of: 'continue', 'repeat', 'go_back', 'jump_to_section', 'summarize', or null (just reply, no navigation)."
        ),
    )
    target_section_idx: Optional[int] = Field(None, description="Target section index for jump_to_section")
    target_paragraph_idx: Optional[int] = Field(None, description="Target paragraph index within the section")


class MessageBody(BaseModel):
    text: str
    section_idx: int
    paragraph_idx: int


# --------------- Meeting agent ---------------

_MEETING_INSTRUCTIONS = """\
You are "Doc", a meeting facilitator reading through a document with the user.

You are currently reading the document aloud paragraph by paragraph. When the user speaks, you pause and respond conversationally.

Context about the current position:
- Document: "{doc_name}"
- Section: "{section_title}" (section {section_num} of {total_sections})
- Paragraph {paragraph_num} of {total_paragraphs} in this section
- Current paragraph text: "{current_paragraph}"

{conversation_context}

Your responsibilities:
1. When the user asks a question about the content, answer it based on the document context.
2. When the user says "continue", "next", "go on", "keep reading" or similar — set tool_action to "continue".
3. When the user says "repeat that", "say that again", "read that again" — set tool_action to "repeat".
4. When the user says "go back", "previous" — set tool_action to "go_back".
5. When the user asks to jump to a specific section — set tool_action to "jump_to_section" with the target indices.
6. When the user asks for a summary — set tool_action to "summarize" and provide a summary in your reply.
7. When the user makes a comment or observation, acknowledge it naturally. Set tool_action to null.

Style rules:
- Conversational meeting voice; this will be read aloud by TTS.
- Keep responses brief (1-3 sentences) unless summarizing.
- No markdown, bullets, or headings.
- Do not reference being an AI.
- Address the user naturally as if in a meeting.
"""


def _build_meeting_agent() -> Agent:
    return Agent(
        name="MeetingFacilitator",
        instructions="You are a meeting facilitator. Your instructions will be provided in the user message.",
        model=_MEETING_MODEL,
        output_type=MeetingResponse,
    )


def _get_document_sections(doc: Document) -> list:
    """Parse document and return sections."""
    body = fs.read_text(doc.rel_path)
    return parse_markdown(body)


def _build_agent_prompt(
    doc_name: str,
    sections: list,
    section_idx: int,
    paragraph_idx: int,
    user_text: str,
    conversation_history: list[MeetingMessage],
) -> str:
    """Build the full prompt for the meeting agent."""
    sec = sections[section_idx] if section_idx < len(sections) else sections[-1]
    paragraphs = split_paragraphs(sec.body)
    current_para = paragraphs[paragraph_idx] if paragraph_idx < len(paragraphs) else paragraphs[-1] if paragraphs else ""

    # Format recent conversation
    conv_lines = []
    for msg in conversation_history[-15:]:
        role_label = "User" if msg.role == "user" else "Doc" if msg.role == "assistant" else "System"
        conv_lines.append(f"{role_label}: {msg.content}")
    conversation_context = ""
    if conv_lines:
        conversation_context = "Recent conversation:\n" + "\n".join(conv_lines)

    system_prompt = _MEETING_INSTRUCTIONS.format(
        doc_name=doc_name,
        section_title=sec.title,
        section_num=section_idx + 1,
        total_sections=len(sections),
        paragraph_num=paragraph_idx + 1,
        total_paragraphs=len(paragraphs),
        current_paragraph=current_para[:500],
        conversation_context=conversation_context,
    )

    # Include a brief document outline
    outline_lines = []
    for i, s in enumerate(sections):
        marker = " ← current" if i == section_idx else ""
        outline_lines.append(f"  {i + 1}. {s.title}{marker}")
    outline = "\n".join(outline_lines)

    return (
        f"{system_prompt}\n\n"
        f"Document outline:\n{outline}\n\n"
        f"The user just said: \"{user_text}\"\n\n"
        f"Respond now."
    )


# --------------- Endpoints ---------------

@router.post("/{doc_id}/start")
def start_meeting(
    doc_id: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Start a new virtual meeting session on a document."""
    with Session(engine) as session:
        doc = session.exec(
            select(Document).where(
                Document.id == doc_id,
                Document.user_id == current_user.id,
            )
        ).first()
        if not doc:
            raise HTTPException(404, "Document not found")

        # Parse document for section info
        sections = _get_document_sections(doc)
        if not sections:
            raise HTTPException(400, "Document has no sections")

        doc_name = doc.rel_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]

        # Create session
        meeting = MeetingSession(
            document_id=doc_id,
            user_id=current_user.id,
            current_section_idx=0,
            current_paragraph_idx=0,
        )
        session.add(meeting)
        session.commit()
        session.refresh(meeting)

        # Generate intro message
        total_sections = len(sections)
        first_section = sections[0].title
        intro_text = (
            f"Hi, let's review {doc_name}. "
            f"It has {total_sections} section{'s' if total_sections != 1 else ''}, "
            f"starting with {first_section}. "
            f"I'll read through it paragraph by paragraph. "
            f"Feel free to jump in any time with questions or comments. Let's begin."
        )

        # Generate intro TTS
        try:
            audio_path, _chars = synthesise_response_audio(
                intro_text, doc_id, 0, 0,
            )
            audio_url = f"/audio/{relative_audio_path(audio_path)}"
        except Exception:
            logger.exception("Failed to generate intro TTS")
            audio_url = None

        # Save system + assistant messages
        sys_msg = MeetingMessage(
            session_id=meeting.id,
            role="system",
            content=f"Meeting started on {doc_name}",
            section_idx=0,
            paragraph_idx=0,
        )
        intro_msg = MeetingMessage(
            session_id=meeting.id,
            role="assistant",
            content=intro_text,
            section_idx=0,
            paragraph_idx=0,
            audio_path=relative_audio_path(audio_path) if audio_url else None,
        )
        session.add(sys_msg)
        session.add(intro_msg)
        session.commit()

        return {
            "session_id": meeting.id,
            "intro_message": intro_text,
            "intro_audio_url": audio_url,
        }


@router.post("/{session_id}/message")
def send_message(
    session_id: str,
    body: MessageBody,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Send a user message and get the AI agent's response."""
    with Session(engine) as session:
        meeting = session.exec(
            select(MeetingSession).where(
                MeetingSession.id == session_id,
                MeetingSession.user_id == current_user.id,
                MeetingSession.status == "active",
            )
        ).first()
        if not meeting:
            raise HTTPException(404, "Meeting session not found or ended")

        doc = session.get(Document, meeting.document_id)
        if not doc:
            raise HTTPException(404, "Document not found")

        doc_name = doc.rel_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]

        # Save user message
        user_msg = MeetingMessage(
            session_id=session_id,
            role="user",
            content=body.text,
            section_idx=body.section_idx,
            paragraph_idx=body.paragraph_idx,
        )
        session.add(user_msg)
        session.commit()

        # Update meeting position
        meeting.current_section_idx = body.section_idx
        meeting.current_paragraph_idx = body.paragraph_idx

        # Load conversation history
        history = session.exec(
            select(MeetingMessage)
            .where(MeetingMessage.session_id == session_id)
            .order_by(MeetingMessage.id)
        ).all()

        # Parse document and run agent
        sections = _get_document_sections(doc)
        prompt = _build_agent_prompt(
            doc_name, sections,
            body.section_idx, body.paragraph_idx,
            body.text, list(history),
        )

        agent = _build_meeting_agent()
        try:
            result = Runner.run_sync(agent, prompt, max_turns=4)
            agent_response: MeetingResponse = result.final_output
        except Exception:
            logger.exception("Meeting agent failed")
            raise HTTPException(500, "AI agent failed to respond")

        reply_text = agent_response.reply.strip()

        # Generate TTS for the reply
        audio_url = None
        audio_rel = None
        try:
            audio_path, _chars = synthesise_response_audio(
                reply_text, doc.id, body.section_idx, body.paragraph_idx,
            )
            audio_rel = relative_audio_path(audio_path)
            audio_url = f"/audio/{audio_rel}"
        except Exception:
            logger.exception("Failed to generate meeting response TTS")

        # Save assistant message
        assistant_msg = MeetingMessage(
            session_id=session_id,
            role="assistant",
            content=reply_text,
            section_idx=body.section_idx,
            paragraph_idx=body.paragraph_idx,
            tool_action=agent_response.tool_action,
            audio_path=audio_rel,
        )
        session.add(assistant_msg)
        session.add(meeting)
        session.commit()

        return {
            "reply": reply_text,
            "tool_action": agent_response.tool_action,
            "target_section_idx": agent_response.target_section_idx,
            "target_paragraph_idx": agent_response.target_paragraph_idx,
            "audio_url": audio_url,
        }


@router.get("/{session_id}/notes")
def get_meeting_notes(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """Get all messages in a meeting session."""
    with Session(engine) as db:
        meeting = db.exec(
            select(MeetingSession).where(
                MeetingSession.id == session_id,
                MeetingSession.user_id == current_user.id,
            )
        ).first()
        if not meeting:
            raise HTTPException(404, "Meeting session not found")

        messages = db.exec(
            select(MeetingMessage)
            .where(MeetingMessage.session_id == session_id)
            .order_by(MeetingMessage.id)
        ).all()

        return [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "section_idx": m.section_idx,
                "paragraph_idx": m.paragraph_idx,
                "tool_action": m.tool_action,
                "audio_url": f"/audio/{m.audio_path}" if m.audio_path else None,
                "created_at": m.created_at.isoformat(),
            }
            for m in messages
        ]


@router.post("/{session_id}/end")
def end_meeting(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """End a meeting session."""
    with Session(engine) as db:
        meeting = db.exec(
            select(MeetingSession).where(
                MeetingSession.id == session_id,
                MeetingSession.user_id == current_user.id,
            )
        ).first()
        if not meeting:
            raise HTTPException(404, "Meeting session not found")

        meeting.status = "ended"
        meeting.ended_at = datetime.utcnow()
        db.add(meeting)
        db.commit()

        return {"status": "ended", "session_id": session_id}


@router.get("/{session_id}/notes/export")
def export_meeting_notes(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> PlainTextResponse:
    """Export meeting notes as markdown."""
    with Session(engine) as db:
        meeting = db.exec(
            select(MeetingSession).where(
                MeetingSession.id == session_id,
                MeetingSession.user_id == current_user.id,
            )
        ).first()
        if not meeting:
            raise HTTPException(404, "Meeting session not found")

        doc = db.get(Document, meeting.document_id)
        doc_name = doc.rel_path.rsplit("/", 1)[-1] if doc else "Unknown"

        messages = db.exec(
            select(MeetingMessage)
            .where(MeetingMessage.session_id == session_id)
            .order_by(MeetingMessage.id)
        ).all()

        lines = [
            f"# Meeting Notes — {doc_name}",
            f"Date: {meeting.created_at.strftime('%Y-%m-%d %H:%M')}",
            "",
            "---",
            "",
        ]
        for m in messages:
            if m.role == "system":
                lines.append(f"*{m.content}*")
            elif m.role == "user":
                lines.append(f"**You:** {m.content}")
            elif m.role == "assistant":
                lines.append(f"**Doc:** {m.content}")
            lines.append("")

        return PlainTextResponse(
            "\n".join(lines),
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{doc_name}-meeting-notes.md"'},
        )
