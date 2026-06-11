"""Symmetric encryption helpers for sensitive per-user tokens.

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the ``cryptography`` package.
The key is derived from the ``ENCRYPTION_KEY`` environment variable — this
MUST be a valid Fernet key (32 url-safe base64 bytes).  Generate one with::

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

This module deliberately does NOT reuse ``JWT_SECRET_KEY``.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken

_ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY", "")

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    if not _ENCRYPTION_KEY:
        raise RuntimeError(
            "ENCRYPTION_KEY env var is not set — required for token encryption"
        )
    _fernet = Fernet(_ENCRYPTION_KEY.encode())
    return _fernet


def encrypt(plaintext: str) -> str:
    """Encrypt *plaintext* and return a url-safe base64 ciphertext string."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Decrypt a Fernet token back to plaintext.

    Raises ``cryptography.fernet.InvalidToken`` on bad input.
    """
    return _get_fernet().decrypt(ciphertext.encode()).decode()
