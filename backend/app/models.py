"""SQLModel definitions for the filesystem-backed review webapp.

Filesystem is the source of truth for document content. SQLite stores only:
- One Document row per markdown file ever opened (keyed by rel_path).
- Review rows tied to (document_id, section_idx, paragraph_idx).

Sections themselves are computed on demand by parsing the file body — they
have no DB row. That keeps the review keys stable when a file is re-parsed
without structural change, and avoids stale FK rows after edits.
"""

from __future__ import annotations

import json
from datetime import datetime
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


class ReviewStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    rel_path: str = Field(index=True, unique=True)
    # Hash of the markdown body at last open. Used to detect external edits.
    content_hash: str = ""
    # JSON list of rel_paths the reviewer should treat as context.
    context_paths_json: str = "[]"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_opened_at: datetime = Field(default_factory=datetime.utcnow)

    @property
    def context_paths(self) -> list[str]:
        try:
            v = json.loads(self.context_paths_json or "[]")
            return [str(p) for p in v if isinstance(p, str)]
        except Exception:
            return []

    def set_context_paths(self, paths: list[str]) -> None:
        self.context_paths_json = json.dumps(list(paths))


class Review(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    section_idx: int = Field(default=0, index=True)
    paragraph_idx: int = Field(default=0, index=True)

    persona: str = "skeptical"
    comment: str
    user_comment: Optional[str] = None

    # Stored verbatim text the agent (Week 2) proposes to replace the paragraph with.
    proposed_replacement: Optional[str] = None

    # Conversational narrator reply produced by the responder agent when the
    # user enables auto-accept mode. When unset, the boilerplate "Noted. We'll
    # factor that in." is used as the response audio.
    narrator_response_text: Optional[str] = None

    narrator_audio_path: Optional[str] = None
    reviewer_audio_path: Optional[str] = None
    response_audio_path: Optional[str] = None

    # Per-review token / character usage. Accumulated across every agent and
    # TTS call that touched this row. Cost is computed on the fly from the
    # configured price-per-million.
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    tts_chars: int = 0

    status: ReviewStatus = Field(default=ReviewStatus.pending)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    resolved_at: Optional[datetime] = None


class AppSettings(SQLModel, table=True):
    """Singleton settings row (id is always 1). Holds per-deployment TTS
    voice / steering choices and the default reviewer persona. Models stay on
    env vars because they shouldn't change at runtime."""

    id: Optional[int] = Field(default=1, primary_key=True)
    narrator_voice: str = "cedar"
    reviewer_voice: str = "marin"
    narrator_instructions: str = (
        "Speak as a clear, neutral, professional technical narrator reading "
        "an engineering specification aloud in a meeting. Measured pace, natural "
        "sentence rhythm, no extra emotion or inflection — your job is to "
        "communicate the content clearly so engineers can follow along."
    )
    reviewer_instructions: str = (
        "Speak as an experienced engineering reviewer reacting in a meeting "
        "after just hearing the narrator read a section aloud. Natural "
        "conversational tone, slightly thoughtful and skeptical, like someone "
        "thinking out loud about a colleague's spec. Pause briefly at commas."
    )
    responder_instructions: str = (
        "Speak as the document's author replying to a reviewer in a meeting. "
        "Warm, brief, professional — acknowledging the point and either "
        "agreeing or briefly clarifying."
    )
    default_persona: str = "skeptical"
    tts_model: str = "gpt-4o-mini-tts"
