"""Health check endpoints for Docker and monitoring."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import APIRouter
from sqlmodel import Session, text

from .db import engine

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health_check() -> dict:
    """Aggregate health check — returns status of all backend dependencies."""
    checks = {}

    # Database connectivity
    try:
        with Session(engine) as session:
            session.exec(text("SELECT 1"))
        checks["database"] = {"status": "ok"}
    except Exception as e:
        checks["database"] = {"status": "error", "detail": str(e)}

    # Redis connectivity (if configured)
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        try:
            import redis as redis_lib

            r = redis_lib.from_url(redis_url, socket_connect_timeout=2)
            r.ping()
            checks["redis"] = {"status": "ok"}
        except Exception as e:
            checks["redis"] = {"status": "error", "detail": str(e)}

    overall = "ok" if all(c["status"] == "ok" for c in checks.values()) else "degraded"

    return {
        "status": overall,
        "service": "backend",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }
