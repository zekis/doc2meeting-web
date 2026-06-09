"""SQLModel definitions for the doc2meeting review webapp.

Tables:
- User: authenticated user accounts (Google OAuth)
- RefreshToken: JWT refresh token revocation tracking
- Document: markdown files opened for review (user-scoped)
- Review: per-paragraph reviewer feedback
- AppSettings: singleton app configuration
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


# ---------- Auth models ----------

class User(SQLModel, table=True):
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True,
        max_length=36,
    )
    email: str = Field(unique=True, index=True, max_length=320)
    name: str = Field(max_length=200)
    tier: str = Field(default="free", index=True)  # free|pro|api|team
    stripe_customer_id: Optional[str] = Field(default=None, index=True, max_length=64)
    is_admin: bool = Field(default=False)
    suspended_at: Optional[datetime] = Field(default=None)
    google_sub: str = Field(unique=True, index=True, max_length=64)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class RefreshToken(SQLModel, table=True):
    __tablename__ = "refresh_token"

    jti: str = Field(primary_key=True, max_length=36)  # uuid4
    user_id: str = Field(foreign_key="user.id", index=True, max_length=36)
    revoked: bool = Field(default=False, index=True)
    expires_at: datetime


# ---------- Content models ----------

class ReviewStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    rel_path: str = Field(index=True)
    content_hash: str = ""
    context_paths_json: str = "[]"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_opened_at: datetime = Field(default_factory=datetime.utcnow)
    # Owner — nullable for backwards compat with pre-auth data
    user_id: Optional[str] = Field(
        default=None, foreign_key="user.id", index=True, max_length=36,
    )

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

    proposed_replacement: Optional[str] = None
    narrator_response_text: Optional[str] = None

    narrator_audio_path: Optional[str] = None
    reviewer_audio_path: Optional[str] = None
    response_audio_path: Optional[str] = None

    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    tts_chars: int = 0

    status: ReviewStatus = Field(default=ReviewStatus.pending)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    resolved_at: Optional[datetime] = None


# ---------- User voice comments (STT) ----------

class UserComment(SQLModel, table=True):
    """Voice-to-text comment recorded by a user on a specific paragraph."""
    __tablename__ = "user_comment"

    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    section_idx: int = Field(default=0)
    paragraph_idx: int = Field(default=0)
    user_id: str = Field(foreign_key="user.id", index=True, max_length=36)
    text: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ---------- Billing / Subscription models ----------

class Subscription(SQLModel, table=True):
    """Stripe subscription linked to a user."""
    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        primary_key=True,
        max_length=36,
    )
    user_id: str = Field(foreign_key="user.id", index=True, max_length=36)
    stripe_customer_id: str = Field(index=True, max_length=64)
    stripe_subscription_id: str = Field(unique=True, index=True, max_length=64)
    stripe_price_id: str = Field(max_length=64)
    tier: str = Field(max_length=20)  # pro|api
    status: str = Field(default="active", index=True, max_length=20)  # active|canceled|past_due|unpaid
    current_period_start: datetime
    current_period_end: datetime
    created_at: datetime = Field(default_factory=datetime.utcnow)
    canceled_at: Optional[datetime] = None


class UsageRecord(SQLModel, table=True):
    """Per-document usage tracking for billing period enforcement."""
    __tablename__ = "usage_record"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True, max_length=36)
    document_id: Optional[int] = Field(default=None, foreign_key="document.id")
    page_count: int = Field(default=0)
    action: str = Field(default="doc_process", max_length=30)  # doc_process|api_call
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


# ---------- App settings ----------

class AppSettings(SQLModel, table=True):
    """Singleton settings row (id is always 1)."""

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
