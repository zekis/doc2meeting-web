"""Google Drive storage backend (Drive API v3, ``drive.file`` scope).

Creates a ``Doc2Audioz/`` folder tree in the user's Drive:

    Doc2Audioz/
    └── <Document Name>/
        ├── <Document Name>.md
        ├── chapter-01.mp3
        ├── chapter-02.mp3
        └── metadata.json

Each document gets its own folder.  Folder IDs are cached per-instance.
"""

from __future__ import annotations

import io
import json
import logging
from typing import Any, BinaryIO

import httpx

from .base import CloudStorage, StorageProvider, StoredFile, register_provider

logger = logging.getLogger(__name__)

DRIVE_API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
TIMEOUT = 10.0  # seconds – matches project convention


class GoogleDriveStorage(CloudStorage):
    """Google Drive backend using a per-user OAuth2 refresh token."""

    def __init__(self, refresh_token: str, client_id: str, client_secret: str):
        self._refresh_token = refresh_token
        self._client_id = client_id
        self._client_secret = client_secret
        self._access_token: str | None = None
        # Folder-ID cache: logical name → Drive folder ID
        self._folder_cache: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Token management
    # ------------------------------------------------------------------

    async def _ensure_access_token(self) -> str:
        """Refresh the access token using the stored refresh token."""
        if self._access_token:
            return self._access_token

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            resp.raise_for_status()
            self._access_token = resp.json()["access_token"]
        return self._access_token  # type: ignore[return-value]

    def _invalidate_token(self) -> None:
        self._access_token = None

    async def _headers(self) -> dict[str, str]:
        token = await self._ensure_access_token()
        return {"Authorization": f"Bearer {token}"}

    # ------------------------------------------------------------------
    # Folder helpers
    # ------------------------------------------------------------------

    async def _find_folder(self, name: str, parent_id: str | None = None) -> str | None:
        """Find a folder by name (optionally under *parent_id*)."""
        q = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        if parent_id:
            q += f" and '{parent_id}' in parents"

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{DRIVE_API}/files",
                headers=await self._headers(),
                params={"q": q, "fields": "files(id,name)", "pageSize": 1},
            )
            resp.raise_for_status()
            files = resp.json().get("files", [])
        return files[0]["id"] if files else None

    async def _create_folder(self, name: str, parent_id: str | None = None) -> str:
        """Create a folder and return its ID."""
        meta: dict = {
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
        }
        if parent_id:
            meta["parents"] = [parent_id]

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{DRIVE_API}/files",
                headers=await self._headers(),
                json=meta,
                params={"fields": "id"},
            )
            resp.raise_for_status()
        return resp.json()["id"]

    async def _ensure_folder(self, name: str, parent_id: str | None = None) -> str:
        """Find-or-create a folder; result is cached."""
        cache_key = f"{parent_id or 'root'}/{name}"
        if cache_key in self._folder_cache:
            return self._folder_cache[cache_key]

        folder_id = await self._find_folder(name, parent_id)
        if not folder_id:
            folder_id = await self._create_folder(name, parent_id)
        self._folder_cache[cache_key] = folder_id
        return folder_id

    async def _resolve_folder_path(self, path: str) -> str:
        """Walk ``path`` (e.g. ``audio/42``) creating folders as needed.

        Returns the Drive folder ID for the deepest segment.
        """
        root_id = await self._ensure_folder("Doc2Audioz")
        parts = [p for p in path.split("/") if p]
        parent = root_id
        for part in parts:
            parent = await self._ensure_folder(part, parent)
        return parent

    # ------------------------------------------------------------------
    # CloudStorage interface
    # ------------------------------------------------------------------

    async def upload_file(
        self,
        path: str,
        data: BinaryIO | bytes,
        mime_type: str = "application/octet-stream",
    ) -> StoredFile:
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            folder_path, filename = parts
        else:
            folder_path, filename = "", parts[0]

        folder_id = await self._resolve_folder_path(folder_path) if folder_path else await self._ensure_folder("Doc2Audioz")

        raw = data if isinstance(data, bytes) else data.read()

        metadata = {"name": filename, "parents": [folder_id]}

        headers = await self._headers()
        # Simple upload for files ≤ 5 MB, multipart metadata for larger
        # (Drive simple upload limit is 5 MB; we use multipart for all
        # sizes here for uniform handling)
        boundary = "doc2meeting_boundary"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f'{{"name": "{filename}", "parents": ["{folder_id}"]}}\r\n'
            f"--{boundary}\r\n"
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode() + raw + f"\r\n--{boundary}--".encode()

        headers["Content-Type"] = f"multipart/related; boundary={boundary}"

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{UPLOAD_API}/files",
                headers=headers,
                content=body,
                params={
                    "uploadType": "multipart",
                    "fields": "id,name,mimeType,size",
                },
            )
            resp.raise_for_status()
            info = resp.json()

        return StoredFile(
            id=info["id"],
            name=info.get("name", filename),
            mime_type=info.get("mimeType", mime_type),
            size=int(info.get("size", 0)),
        )

    async def download_file(self, path: str) -> bytes:
        file_id = await self._find_file_id(path)
        if not file_id:
            raise FileNotFoundError(f"File not found in Drive: {path}")

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{DRIVE_API}/files/{file_id}",
                headers=await self._headers(),
                params={"alt": "media"},
            )
            resp.raise_for_status()
        return resp.content

    async def delete_file(self, path: str) -> None:
        file_id = await self._find_file_id(path)
        if not file_id:
            return  # no-op per contract

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.delete(
                f"{DRIVE_API}/files/{file_id}",
                headers=await self._headers(),
            )
            # 404 is fine – already gone
            if resp.status_code != 404:
                resp.raise_for_status()

    async def list_files(self, prefix: str = "") -> list[StoredFile]:
        root_id = await self._ensure_folder("Doc2Audioz")

        # If a prefix targets a subfolder, resolve it
        if prefix:
            try:
                folder_id = await self._resolve_folder_path(prefix)
            except httpx.HTTPStatusError:
                return []
        else:
            folder_id = root_id

        results: list[StoredFile] = []
        page_token: str | None = None

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            while True:
                params: dict = {
                    "q": f"'{folder_id}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'",
                    "fields": "nextPageToken,files(id,name,mimeType,size)",
                    "pageSize": 100,
                }
                if page_token:
                    params["pageToken"] = page_token

                resp = await client.get(
                    f"{DRIVE_API}/files",
                    headers=await self._headers(),
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()

                for f in data.get("files", []):
                    results.append(
                        StoredFile(
                            id=f["id"],
                            name=f.get("name", ""),
                            mime_type=f.get("mimeType", ""),
                            size=int(f.get("size", 0)),
                        )
                    )

                page_token = data.get("nextPageToken")
                if not page_token:
                    break

        return results

    async def download_by_id(self, file_id: str) -> bytes:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{DRIVE_API}/files/{file_id}",
                headers=await self._headers(),
                params={"alt": "media"},
            )
            resp.raise_for_status()
        return resp.content

    async def delete_by_id(self, file_id: str) -> None:
        """Delete a file by its Drive file ID. No-op if already gone."""
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.delete(
                f"{DRIVE_API}/files/{file_id}",
                headers=await self._headers(),
            )
            if resp.status_code != 404:
                resp.raise_for_status()

    # ------------------------------------------------------------------
    # Document-folder helpers (Phase B)
    # ------------------------------------------------------------------

    async def ensure_document_folder(self, doc_name: str) -> str:
        """Create/find ``Doc2Audioz/<doc_name>/`` and return its folder ID."""
        root_id = await self._ensure_folder("Doc2Audioz")
        return await self._ensure_folder(doc_name, root_id)

    async def upload_to_document_folder(
        self,
        doc_name: str,
        filename: str,
        data: bytes,
        mime_type: str = "application/octet-stream",
    ) -> StoredFile:
        """Upload a file into ``Doc2Audioz/<doc_name>/<filename>``."""
        folder_id = await self.ensure_document_folder(doc_name)

        # Check for existing file with same name and overwrite (update)
        existing_id = await self._find_file_in_folder(filename, folder_id)
        if existing_id:
            return await self._update_file(existing_id, data, mime_type)

        boundary = "Doc2Audioz_boundary"
        meta_json = json.dumps({"name": filename, "parents": [folder_id]})
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{meta_json}\r\n"
            f"--{boundary}\r\n"
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--".encode()

        headers = await self._headers()
        headers["Content-Type"] = f"multipart/related; boundary={boundary}"

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{UPLOAD_API}/files",
                headers=headers,
                content=body,
                params={
                    "uploadType": "multipart",
                    "fields": "id,name,mimeType,size",
                },
            )
            resp.raise_for_status()
            info = resp.json()

        return StoredFile(
            id=info["id"],
            name=info.get("name", filename),
            mime_type=info.get("mimeType", mime_type),
            size=int(info.get("size", 0)),
        )

    async def upload_metadata(
        self, doc_name: str, metadata: dict[str, Any],
    ) -> StoredFile:
        """Upload/update ``metadata.json`` in a document folder."""
        data = json.dumps(metadata, indent=2).encode()
        return await self.upload_to_document_folder(
            doc_name, "metadata.json", data, "application/json",
        )

    async def list_document_folders(self) -> list[dict[str, str]]:
        """List all document folders under ``Doc2Audioz/``.

        Returns list of ``{"id": ..., "name": ...}`` dicts.
        """
        root_id = await self._ensure_folder("Doc2Audioz")
        results: list[dict[str, str]] = []
        page_token: str | None = None

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            while True:
                params: dict = {
                    "q": (
                        f"'{root_id}' in parents and trashed=false "
                        f"and mimeType='application/vnd.google-apps.folder'"
                    ),
                    "fields": "nextPageToken,files(id,name)",
                    "pageSize": 100,
                }
                if page_token:
                    params["pageToken"] = page_token
                resp = await client.get(
                    f"{DRIVE_API}/files",
                    headers=await self._headers(),
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()
                for f in data.get("files", []):
                    results.append({"id": f["id"], "name": f["name"]})
                page_token = data.get("nextPageToken")
                if not page_token:
                    break
        return results

    async def list_document_folder_files(
        self, doc_name: str,
    ) -> list[StoredFile]:
        """List all files inside a specific document folder."""
        folder_id = await self.ensure_document_folder(doc_name)
        return await self._list_files_in_folder(folder_id)

    async def delete_document_folder(self, doc_name: str) -> None:
        """Delete an entire document folder and all its contents."""
        root_id = await self._ensure_folder("Doc2Audioz")
        folder_id = await self._find_folder(doc_name, root_id)
        if not folder_id:
            return
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.delete(
                f"{DRIVE_API}/files/{folder_id}",
                headers=await self._headers(),
            )
            if resp.status_code != 404:
                resp.raise_for_status()
        # Clear from cache
        cache_key = f"{root_id}/{doc_name}"
        self._folder_cache.pop(cache_key, None)

    async def _find_file_in_folder(
        self, filename: str, folder_id: str,
    ) -> str | None:
        """Find a file by name within a specific folder."""
        q = (
            f"name='{filename}' and '{folder_id}' in parents "
            f"and trashed=false "
            f"and mimeType!='application/vnd.google-apps.folder'"
        )
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{DRIVE_API}/files",
                headers=await self._headers(),
                params={"q": q, "fields": "files(id)", "pageSize": 1},
            )
            resp.raise_for_status()
            files = resp.json().get("files", [])
        return files[0]["id"] if files else None

    async def _update_file(
        self, file_id: str, data: bytes, mime_type: str,
    ) -> StoredFile:
        """Replace the content of an existing Drive file."""
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.patch(
                f"{UPLOAD_API}/files/{file_id}",
                headers={
                    **(await self._headers()),
                    "Content-Type": mime_type,
                },
                content=data,
                params={
                    "uploadType": "media",
                    "fields": "id,name,mimeType,size",
                },
            )
            resp.raise_for_status()
            info = resp.json()
        return StoredFile(
            id=info["id"],
            name=info.get("name", ""),
            mime_type=info.get("mimeType", mime_type),
            size=int(info.get("size", 0)),
        )

    async def _list_files_in_folder(
        self, folder_id: str,
    ) -> list[StoredFile]:
        """List non-folder files in a specific folder."""
        results: list[StoredFile] = []
        page_token: str | None = None

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            while True:
                params: dict = {
                    "q": (
                        f"'{folder_id}' in parents and trashed=false "
                        f"and mimeType!='application/vnd.google-apps.folder'"
                    ),
                    "fields": "nextPageToken,files(id,name,mimeType,size)",
                    "pageSize": 100,
                }
                if page_token:
                    params["pageToken"] = page_token
                resp = await client.get(
                    f"{DRIVE_API}/files",
                    headers=await self._headers(),
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()
                for f in data.get("files", []):
                    results.append(StoredFile(
                        id=f["id"],
                        name=f.get("name", ""),
                        mime_type=f.get("mimeType", ""),
                        size=int(f.get("size", 0)),
                    ))
                page_token = data.get("nextPageToken")
                if not page_token:
                    break
        return results

    # ------------------------------------------------------------------
    # User file browsing (requires drive.readonly scope)
    # ------------------------------------------------------------------

    async def list_user_files(
        self,
        folder_id: str | None = None,
        query: str | None = None,
        page_token: str | None = None,
        page_size: int = 50,
    ) -> dict:
        """List files in the user's Drive for browsing/importing.

        If *folder_id* is given, lists files in that folder.
        If *query* is given, searches by name across the entire Drive.
        Otherwise lists files in the root ("My Drive").

        Returns ``{"files": [...], "nextPageToken": str|None}``.
        """
        supported_mimes = (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/pdf",
            "text/markdown",
            "text/plain",
            "application/vnd.google-apps.folder",
        )

        if query:
            # Full-text search across Drive — show matching docs + folders
            q_parts = [
                f"name contains '{query}'",
                "trashed=false",
            ]
            q = " and ".join(q_parts)
        elif folder_id:
            q = f"'{folder_id}' in parents and trashed=false"
        else:
            q = "'root' in parents and trashed=false"

        params: dict = {
            "q": q,
            "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime,iconLink)",
            "pageSize": page_size,
            "orderBy": "folder,name",
        }
        if page_token:
            params["pageToken"] = page_token

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{DRIVE_API}/files",
                headers=await self._headers(),
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()

        # Filter to supported types (folders + supported docs)
        files = []
        for f in data.get("files", []):
            mime = f.get("mimeType", "")
            if mime in supported_mimes:
                files.append({
                    "id": f["id"],
                    "name": f.get("name", ""),
                    "mimeType": mime,
                    "size": int(f.get("size", 0)) if f.get("size") else 0,
                    "modifiedTime": f.get("modifiedTime", ""),
                    "isFolder": mime == "application/vnd.google-apps.folder",
                })

        return {
            "files": files,
            "nextPageToken": data.get("nextPageToken"),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _find_file_id(self, path: str) -> str | None:
        """Resolve a logical path to a Drive file ID."""
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            folder_path, filename = parts
        else:
            folder_path, filename = "", parts[0]

        try:
            if folder_path:
                folder_id = await self._resolve_folder_path(folder_path)
            else:
                folder_id = await self._ensure_folder("Doc2Audioz")
        except httpx.HTTPStatusError:
            return None

        q = (
            f"name='{filename}' and '{folder_id}' in parents "
            f"and trashed=false "
            f"and mimeType!='application/vnd.google-apps.folder'"
        )

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{DRIVE_API}/files",
                headers=await self._headers(),
                params={"q": q, "fields": "files(id)", "pageSize": 1},
            )
            resp.raise_for_status()
            files = resp.json().get("files", [])
        return files[0]["id"] if files else None


# ---------------------------------------------------------------------------
# Factory registration
# ---------------------------------------------------------------------------

def _factory(
    refresh_token: str,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> GoogleDriveStorage:
    import os

    cid = client_id or os.environ.get("GOOGLE_CLIENT_ID", "")
    csecret = client_secret or os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not cid or not csecret:
        raise RuntimeError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set")
    return GoogleDriveStorage(refresh_token, cid, csecret)


register_provider(StorageProvider.google_drive, _factory)
