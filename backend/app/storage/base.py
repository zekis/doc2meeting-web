"""Storage abstraction – ABC and provider registry.

Every cloud backend implements ``CloudStorage``.  The registry maps
``StorageProvider`` enum values to factory callables so the app can
resolve the right backend at runtime.
"""

from __future__ import annotations

import io
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import BinaryIO, Callable


class StorageProvider(str, Enum):
    none = "none"
    google_drive = "google_drive"


@dataclass
class StoredFile:
    """Metadata returned after an upload or from a listing."""

    id: str  # provider-specific file ID
    name: str
    mime_type: str
    size: int  # bytes, 0 when unknown


class CloudStorage(ABC):
    """Abstract interface every storage backend must implement."""

    @abstractmethod
    async def upload_file(
        self,
        path: str,
        data: BinaryIO | bytes,
        mime_type: str = "application/octet-stream",
    ) -> StoredFile:
        """Upload *data* to *path* (e.g. ``documents/readme.md``).

        ``path`` is a logical path relative to the user's storage root.
        The backend decides how to map it to real provider paths/folders.
        """

    @abstractmethod
    async def download_file(self, path: str) -> bytes:
        """Return the raw bytes of the file at *path*."""

    @abstractmethod
    async def delete_file(self, path: str) -> None:
        """Delete the file at *path*.  No-op if not found."""

    @abstractmethod
    async def list_files(self, prefix: str = "") -> list[StoredFile]:
        """List files whose logical path starts with *prefix*."""


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

# Maps provider enum → factory(user_id, refresh_token) → CloudStorage
_registry: dict[StorageProvider, Callable[..., CloudStorage]] = {}


def register_provider(
    provider: StorageProvider,
    factory: Callable[..., CloudStorage],
) -> None:
    """Register a factory that creates a ``CloudStorage`` for *provider*."""
    _registry[provider] = factory


def get_storage(
    provider: StorageProvider,
    **kwargs,
) -> CloudStorage:
    """Resolve and instantiate the storage backend for *provider*.

    Extra *kwargs* (e.g. ``refresh_token``) are forwarded to the factory.
    Raises ``ValueError`` if the provider is unknown or ``none``.
    """
    if provider == StorageProvider.none:
        raise ValueError("User has no storage provider configured")
    factory = _registry.get(provider)
    if factory is None:
        raise ValueError(f"Unknown storage provider: {provider}")
    return factory(**kwargs)
