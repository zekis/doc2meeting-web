"""Tests for the storage abstraction layer and mock/local backend.

Verifies that:
- The ABC interface is correctly defined
- The provider registry works (register + resolve)
- A mock implementation passes the full contract
- The Google Drive factory is registered
- Crypto encrypt/decrypt round-trips correctly
"""

import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Set ENCRYPTION_KEY for crypto tests (must be valid Fernet key)
os.environ.setdefault(
    "ENCRYPTION_KEY",
    "dGVzdC1lbmNyeXB0aW9uLWtleS0xMjM0NTY3ODk=",  # placeholder — overridden below
)

from app.storage.base import (
    CloudStorage,
    StorageProvider,
    StoredFile,
    get_storage,
    register_provider,
    _registry,
)


# ---------------------------------------------------------------------------
# Mock implementation for testing the ABC contract
# ---------------------------------------------------------------------------


class MockStorage(CloudStorage):
    """In-memory storage backend for testing."""

    def __init__(self):
        self._files: dict[str, bytes] = {}

    async def upload_file(self, path, data, mime_type="application/octet-stream"):
        raw = data if isinstance(data, bytes) else data.read()
        self._files[path] = raw
        return StoredFile(
            id=str(uuid.uuid4()),
            name=path.rsplit("/", 1)[-1],
            mime_type=mime_type,
            size=len(raw),
        )

    async def download_file(self, path):
        if path not in self._files:
            raise FileNotFoundError(path)
        return self._files[path]

    async def delete_file(self, path):
        self._files.pop(path, None)

    async def list_files(self, prefix=""):
        return [
            StoredFile(id=str(uuid.uuid4()), name=k, mime_type="", size=len(v))
            for k, v in self._files.items()
            if k.startswith(prefix)
        ]


# ---------------------------------------------------------------------------
# ABC / Registry tests
# ---------------------------------------------------------------------------


def test_storage_provider_enum():
    assert StorageProvider.none == "none"
    assert StorageProvider.google_drive == "google_drive"


def test_register_and_resolve():
    """Register a mock provider and resolve it."""
    register_provider(StorageProvider.none, lambda: MockStorage())
    try:
        # The normal get_storage rejects "none" — but the factory IS registered
        assert StorageProvider.none in _registry
    finally:
        _registry.pop(StorageProvider.none, None)


def test_get_storage_raises_for_none():
    with pytest.raises(ValueError, match="no storage provider"):
        get_storage(StorageProvider.none)


def test_get_storage_raises_for_invalid_enum():
    """Constructing StorageProvider with an invalid value raises ValueError."""
    with pytest.raises(ValueError):
        StorageProvider("nonexistent")


def test_google_drive_factory_registered():
    """Importing google_drive module should register the factory."""
    from app.storage import google_drive  # noqa: F401

    assert StorageProvider.google_drive in _registry


# ---------------------------------------------------------------------------
# Mock backend contract tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_upload_download():
    store = MockStorage()
    content = b"hello world"
    result = await store.upload_file("documents/test.md", content, "text/markdown")
    assert result.name == "test.md"
    assert result.size == len(content)

    data = await store.download_file("documents/test.md")
    assert data == content


@pytest.mark.asyncio
async def test_mock_delete():
    store = MockStorage()
    await store.upload_file("documents/test.md", b"data")
    await store.delete_file("documents/test.md")
    with pytest.raises(FileNotFoundError):
        await store.download_file("documents/test.md")


@pytest.mark.asyncio
async def test_mock_delete_nonexistent():
    """delete_file on a missing path should be a no-op."""
    store = MockStorage()
    await store.delete_file("does/not/exist.txt")  # should not raise


@pytest.mark.asyncio
async def test_mock_list_files():
    store = MockStorage()
    await store.upload_file("documents/a.md", b"a")
    await store.upload_file("documents/b.md", b"bb")
    await store.upload_file("audio/1/track.mp3", b"audio")

    docs = await store.list_files("documents/")
    assert len(docs) == 2

    all_files = await store.list_files("")
    assert len(all_files) == 3


# ---------------------------------------------------------------------------
# Crypto round-trip test
# ---------------------------------------------------------------------------


def test_crypto_encrypt_decrypt():
    """Fernet encrypt → decrypt round-trips correctly."""
    from cryptography.fernet import Fernet

    # Use a real generated key
    key = Fernet.generate_key().decode()
    os.environ["ENCRYPTION_KEY"] = key

    # Reset the cached fernet instance
    import app.crypto as crypto_mod
    crypto_mod._fernet = None
    crypto_mod._ENCRYPTION_KEY = key

    plaintext = "ya29.super-secret-refresh-token"
    ciphertext = crypto_mod.encrypt(plaintext)
    assert ciphertext != plaintext
    assert crypto_mod.decrypt(ciphertext) == plaintext


def test_crypto_raises_without_key():
    """encrypt() should raise if ENCRYPTION_KEY is unset."""
    import app.crypto as crypto_mod
    crypto_mod._fernet = None
    crypto_mod._ENCRYPTION_KEY = ""

    with pytest.raises(RuntimeError, match="ENCRYPTION_KEY"):
        crypto_mod.encrypt("test")
