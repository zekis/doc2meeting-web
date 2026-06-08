"""User CRUD operations.

Phase 1: upsert by Google sub (OAuth), get by id/email, update tier.
"""

from __future__ import annotations

from sqlmodel import Session, select

from .models import User


def upsert_by_google_sub(
    session: Session,
    *,
    google_sub: str,
    email: str,
    name: str,
) -> User:
    """Find or create a user by their Google subject identifier."""
    user = session.exec(
        select(User).where(User.google_sub == google_sub)
    ).first()
    if user:
        user.email = email
        user.name = name
        session.add(user)
        session.commit()
        session.refresh(user)
        return user
    user = User(google_sub=google_sub, email=email, name=name)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def get_by_id(session: Session, user_id: str) -> User | None:
    return session.get(User, user_id)


def get_by_email(session: Session, email: str) -> User | None:
    return session.exec(select(User).where(User.email == email)).first()


def update_tier(session: Session, user_id: str, tier: str) -> User:
    user = session.get(User, user_id)
    if not user:
        raise ValueError(f"User {user_id} not found")
    user.tier = tier
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def soft_delete_user(session: Session, user_id: str) -> None:
    """Placeholder for GDPR compliance -- Phase 4."""
    raise NotImplementedError("Phase 4")
