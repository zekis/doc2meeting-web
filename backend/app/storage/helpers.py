"""Storage helpers — convenience wrappers for the storage abstraction layer."""

from __future__ import annotations

import logging

from ..crypto import decrypt
from ..models import User
from .base import CloudStorage, StorageProvider, get_storage

logger = logging.getLogger(__name__)


def get_user_storage(user: User) -> CloudStorage | None:
    """Return the storage backend for *user*, or ``None`` if not configured.

    Handles decryption of the stored refresh token and catches configuration
    errors so callers can fall back to local storage gracefully.
    """
    if user.storage_provider == "none" or not user.drive_refresh_token:
        return None
    try:
        token = decrypt(user.drive_refresh_token)
        return get_storage(StorageProvider(user.storage_provider), refresh_token=token)
    except Exception:
        logger.warning("Failed to initialise storage for user %s", user.id, exc_info=True)
        return None
