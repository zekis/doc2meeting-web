"""Stripe billing integration — checkout, webhooks, usage, and admin endpoints.

Split into sub-modules:
- constants: Stripe config, tier limits
- checkout: Checkout sessions, billing info, portal
- webhooks: Stripe webhook handler (idempotent, atomic)
- usage: Tier enforcement, usage tracking, metered billing
- admin: Admin billing and usage endpoints
"""

from __future__ import annotations

from fastapi import APIRouter

from .admin import router as admin_router
from .checkout import router as checkout_router
from .constants import TIER_LIMITS
from .usage import check_usage_limits, record_usage
from .usage import router as usage_router
from .webhooks import router as webhooks_router

# Re-export for backwards compatibility with existing imports
__all__ = ["router", "check_usage_limits", "record_usage", "TIER_LIMITS"]

# Combine all sub-routers into one
router = APIRouter()
router.include_router(checkout_router)
router.include_router(webhooks_router)
router.include_router(usage_router)
router.include_router(admin_router)
