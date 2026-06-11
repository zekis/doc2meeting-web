"""Cloud storage abstraction layer.

Provides a pluggable backend for file storage (Google Drive, local, etc.).
Use ``get_storage()`` to resolve the active backend for a user.
"""

from .base import CloudStorage, StorageProvider, get_storage, register_provider

__all__ = ["CloudStorage", "StorageProvider", "get_storage", "register_provider"]
