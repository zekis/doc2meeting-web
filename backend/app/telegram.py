"""Telegram bot integration — reference implementation.

Demonstrates how to use the doc2meeting API via a Telegram bot:
- /start: Register/link Telegram user
- /review <url_or_id>: Check review status
- /export <doc_id>: Get structured notes as a message
- Webhook receives document updates and sends notifications

This module provides both:
1. A webhook endpoint for Telegram Bot API
2. Helper functions for sending messages via the Telegram API

To set up:
1. Create a bot via @BotFather on Telegram
2. Set TELEGRAM_BOT_TOKEN in .env
3. Register webhook: POST /api/telegram/setup-webhook
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from .db import engine, get_session
from .middleware import get_current_user
from .models import Document, Review, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/telegram", tags=["telegram"])

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API_BASE = "https://api.telegram.org"


# ---------------------------------------------------------------------------
# Telegram API helpers
# ---------------------------------------------------------------------------

async def _send_message(chat_id: int | str, text: str, parse_mode: str = "Markdown") -> dict:
    """Send a message to a Telegram chat."""
    if not TELEGRAM_BOT_TOKEN:
        logger.warning("Telegram bot token not configured")
        return {"ok": False, "description": "Bot token not configured"}

    url = f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": parse_mode,
        })
        return resp.json()


async def _send_document(chat_id: int | str, document_url: str, caption: str = "") -> dict:
    """Send a document to a Telegram chat."""
    if not TELEGRAM_BOT_TOKEN:
        return {"ok": False, "description": "Bot token not configured"}

    url = f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/sendDocument"
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={
            "chat_id": chat_id,
            "document": document_url,
            "caption": caption,
        })
        return resp.json()


# ---------------------------------------------------------------------------
# Webhook endpoint — receives updates from Telegram
# ---------------------------------------------------------------------------

@router.post("/webhook")
async def telegram_webhook(request: Request):
    """Handle incoming Telegram Bot API updates.

    The bot supports these commands:
    - /start - Link Telegram account
    - /status - Show account info
    - /review <doc_id> - Get review summary for a document
    - /export <doc_id> - Get structured notes export
    - /help - Show available commands
    """
    body = await request.json()
    message = body.get("message", {})
    text = message.get("text", "")
    chat_id = message.get("chat", {}).get("id")

    if not chat_id:
        return {"ok": True}

    # Route commands
    if text.startswith("/start"):
        await _handle_start(chat_id, message)
    elif text.startswith("/status"):
        await _handle_status(chat_id, message)
    elif text.startswith("/review"):
        await _handle_review(chat_id, text)
    elif text.startswith("/export"):
        await _handle_export(chat_id, text)
    elif text.startswith("/help"):
        await _handle_help(chat_id)
    else:
        await _send_message(
            chat_id,
            "Unknown command. Send /help for available commands."
        )

    return {"ok": True}


async def _handle_start(chat_id: int, message: dict):
    """Handle /start — greet user and explain linking."""
    from_user = message.get("from", {})
    name = from_user.get("first_name", "there")

    await _send_message(chat_id, (
        f"👋 Hi {name}! Welcome to *doc2meeting*.\n\n"
        "I can help you check review status and export notes for your documents.\n\n"
        "To link your account, use the API with your Telegram chat ID:\n"
        f"`{chat_id}`\n\n"
        "Commands:\n"
        "/status — Check your account\n"
        "/review <doc_id> — Review summary\n"
        "/export <doc_id> — Export structured notes\n"
        "/help — Show this message"
    ))


async def _handle_status(chat_id: int, message: dict):
    """Handle /status — show linked account info."""
    with Session(engine) as session:
        # Look up user by telegram_chat_id (stored in user metadata)
        # For this reference implementation, we look up by a simple mapping
        user = _find_user_by_chat_id(session, chat_id)
        if not user:
            await _send_message(chat_id, (
                "⚠️ No linked account found.\n\n"
                "Link your account through the web app settings or contact support."
            ))
            return

        doc_count = session.exec(
            select(func.count()).select_from(Document).where(Document.user_id == user.id)
        ).one()

        await _send_message(chat_id, (
            f"👤 *Account Status*\n\n"
            f"Name: {user.name}\n"
            f"Email: {user.email}\n"
            f"Tier: {user.tier}\n"
            f"Documents: {doc_count}"
        ))


async def _handle_review(chat_id: int, text: str):
    """Handle /review <doc_id> — show review summary."""
    parts = text.strip().split()
    if len(parts) < 2:
        await _send_message(chat_id, "Usage: `/review <document_id>`")
        return

    try:
        doc_id = int(parts[1])
    except ValueError:
        await _send_message(chat_id, "Invalid document ID. Usage: `/review <document_id>`")
        return

    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if not doc:
            await _send_message(chat_id, f"Document {doc_id} not found.")
            return

        reviews = session.exec(
            select(Review).where(Review.document_id == doc_id)
        ).all()

        if not reviews:
            await _send_message(chat_id, f"No reviews yet for document `{doc.rel_path}`.")
            return

        accepted = sum(1 for r in reviews if r.status.value == "accepted")
        rejected = sum(1 for r in reviews if r.status.value == "rejected")
        pending = sum(1 for r in reviews if r.status.value == "pending")

        await _send_message(chat_id, (
            f"📄 *Review Summary*\n\n"
            f"Document: `{doc.rel_path}`\n"
            f"Total reviews: {len(reviews)}\n"
            f"✅ Accepted: {accepted}\n"
            f"❌ Rejected: {rejected}\n"
            f"⏳ Pending: {pending}\n\n"
            f"Use `/export {doc_id}` to get the full notes."
        ))


async def _handle_export(chat_id: int, text: str):
    """Handle /export <doc_id> — send structured notes."""
    parts = text.strip().split()
    if len(parts) < 2:
        await _send_message(chat_id, "Usage: `/export <document_id>`")
        return

    try:
        doc_id = int(parts[1])
    except ValueError:
        await _send_message(chat_id, "Invalid document ID.")
        return

    with Session(engine) as session:
        doc = session.get(Document, doc_id)
        if not doc:
            await _send_message(chat_id, f"Document {doc_id} not found.")
            return

        reviews = session.exec(
            select(Review)
            .where(Review.document_id == doc_id)
            .order_by(Review.section_idx, Review.paragraph_idx)
        ).all()

        if not reviews:
            await _send_message(chat_id, "No reviews to export.")
            return

        # Build a concise summary
        lines = [f"📋 *Export: {doc.rel_path}*\n"]
        for r in reviews:
            status_icon = {
                "accepted": "✅", "rejected": "❌", "pending": "⏳"
            }.get(r.status.value, "•")
            lines.append(f"{status_icon} S{r.section_idx + 1}P{r.paragraph_idx + 1}: {r.comment[:100]}")
            if r.status.value == "accepted" and r.proposed_replacement:
                lines.append(f"  → _{r.proposed_replacement[:80]}_")

        # Telegram has a 4096 char message limit
        msg = "\n".join(lines)
        if len(msg) > 4000:
            msg = msg[:3997] + "..."

        await _send_message(chat_id, msg)


async def _handle_help(chat_id: int):
    """Handle /help — show available commands."""
    await _send_message(chat_id, (
        "📖 *doc2meeting Bot Commands*\n\n"
        "/start — Get started & link account\n"
        "/status — Check your account info\n"
        "/review <doc\\_id> — Review summary\n"
        "/export <doc\\_id> — Export structured notes\n"
        "/help — Show this message\n\n"
        "Visit the web app for full functionality."
    ))


def _find_user_by_chat_id(session: Session, chat_id: int) -> Optional[User]:
    """Look up a user by Telegram chat ID.

    For this reference implementation, the chat_id would be stored
    as a field on the User model or in a separate mapping table.
    This is a placeholder that returns None — implement linking
    via the web app or /start command with an API key.
    """
    # TODO: Add telegram_chat_id to User model or create a mapping table
    # For now, this is a reference implementation showing the pattern
    return None


# ---------------------------------------------------------------------------
# Setup endpoint — register webhook with Telegram
# ---------------------------------------------------------------------------

class WebhookSetupRequest(BaseModel):
    webhook_url: str  # e.g., "https://meet.erp-portal.au/api/telegram/webhook"


@router.post("/setup-webhook")
async def setup_telegram_webhook(
    body: WebhookSetupRequest,
    user: User = Depends(get_current_user),
):
    """Register the webhook URL with Telegram Bot API. Admin only."""
    if not user.is_admin:
        raise HTTPException(403, detail="admin access required")

    if not TELEGRAM_BOT_TOKEN:
        raise HTTPException(503, detail="TELEGRAM_BOT_TOKEN not configured")

    url = f"{TELEGRAM_API_BASE}/bot{TELEGRAM_BOT_TOKEN}/setWebhook"
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json={"url": body.webhook_url})
        result = resp.json()

    if not result.get("ok"):
        raise HTTPException(502, detail=f"Telegram API error: {result.get('description', 'unknown')}")

    return {"status": "ok", "webhook_url": body.webhook_url, "telegram_response": result}


# ---------------------------------------------------------------------------
# Notification helper — call from other modules to push updates
# ---------------------------------------------------------------------------

async def notify_review_complete(user: User, doc: Document, review_count: int):
    """Send a Telegram notification when a document review is complete.

    Call this from the review pipeline after all paragraphs are reviewed.
    Requires the user to have a linked Telegram chat ID.
    """
    # Placeholder — requires user linking implementation
    pass


# Import func here to avoid circular issues at module level
from sqlmodel import func
