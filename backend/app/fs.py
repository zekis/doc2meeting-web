"""Filesystem service.

The review server is rooted at ROOT_DIR; everything outside that tree is
inaccessible. All relative paths in the API are interpreted under that root.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

# Load .env here too so any consumer of this module (probes, REPL, tests, the
# FastAPI app) sees the configured ROOT_DIR. Safe to call multiple times.
from dotenv import load_dotenv
load_dotenv()

_ROOT_DIR = Path(os.environ.get("ROOT_DIR", "./reviewable")).resolve()
_ROOT_DIR.mkdir(parents=True, exist_ok=True)


def root_dir() -> Path:
    return _ROOT_DIR


def resolve_rel(rel_path: str) -> Path:
    """Resolve a user-supplied relative path under ROOT_DIR. Reject escapes."""
    if not rel_path:
        raise ValueError("Empty path")
    # Normalise separators and forbid drive letters / absolute paths.
    rel = rel_path.replace("\\", "/").lstrip("/")
    candidate = (_ROOT_DIR / rel).resolve()
    try:
        candidate.relative_to(_ROOT_DIR)
    except ValueError as e:
        raise ValueError(f"Path '{rel_path}' escapes ROOT_DIR") from e
    return candidate


def to_rel(abs_path: Path) -> str:
    """Return a relative path string under ROOT_DIR for an absolute path."""
    return abs_path.resolve().relative_to(_ROOT_DIR).as_posix()


def read_text(rel_path: str) -> str:
    return resolve_rel(rel_path).read_text(encoding="utf-8", errors="replace")


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


@dataclass
class TreeNode:
    name: str
    type: str            # "folder" | "file"
    rel_path: str
    children: list["TreeNode"] | None = None
    size: int = 0
    mtime: float = 0.0

    def to_dict(self) -> dict:
        out: dict = {
            "name": self.name,
            "type": self.type,
            "rel_path": self.rel_path,
        }
        if self.type == "folder":
            out["children"] = [c.to_dict() for c in (self.children or [])]
        else:
            out["size"] = self.size
            out["mtime"] = self.mtime
        return out


_IGNORE_NAMES = {".git", ".hg", "__pycache__", ".venv", "node_modules", ".idea", ".vscode"}


def list_tree(
    extensions: tuple[str, ...] = (".md", ".markdown", ".docx")
) -> TreeNode:
    """Walk ROOT_DIR recursively and return a tree of folders + matching files.

    Folders that end up with no matching descendants are pruned so the tree
    surfaces just the things you can actually open.
    """
    root_node = _walk(_ROOT_DIR, extensions)
    if root_node is None:
        # Empty root — return a stub so the UI always has something to render.
        return TreeNode(name=_ROOT_DIR.name, type="folder", rel_path="", children=[])
    return root_node


def _walk(d: Path, extensions: tuple[str, ...]) -> TreeNode | None:
    if not d.is_dir():
        return None
    children: list[TreeNode] = []
    try:
        entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except PermissionError:
        return None
    for entry in entries:
        if entry.name.startswith(".") or entry.name in _IGNORE_NAMES:
            continue
        if entry.is_dir():
            sub = _walk(entry, extensions)
            if sub and sub.children:
                children.append(sub)
        elif entry.is_file() and entry.suffix.lower() in extensions:
            try:
                stat = entry.stat()
            except OSError:
                continue
            children.append(
                TreeNode(
                    name=entry.name,
                    type="file",
                    rel_path=to_rel(entry),
                    size=stat.st_size,
                    mtime=stat.st_mtime,
                )
            )
    if not children and d != _ROOT_DIR:
        return None
    return TreeNode(
        name=d.name if d != _ROOT_DIR else (d.name or "root"),
        type="folder",
        rel_path=to_rel(d) if d != _ROOT_DIR else "",
        children=children,
    )


_VERSION_SUFFIX_RE = re.compile(r"_v(\d+)$")


def next_version_path(rel_path: str) -> Path:
    """Compute the next `_v<N>.md` filename for the given file.

    The stem is the basename with any `_v<N>` already stripped — so saving
    `foo_v2.md` produces `foo_v3.md`, not `foo_v2_v3.md`. Versions land in the
    same folder as the source.
    """
    src = resolve_rel(rel_path)
    if not src.is_file():
        raise FileNotFoundError(rel_path)

    folder = src.parent
    stem = src.stem  # without suffix
    suffix = src.suffix  # ".md"

    m = _VERSION_SUFFIX_RE.search(stem)
    base_stem = stem[: m.start()] if m else stem

    existing_versions: list[int] = []
    for sibling in folder.glob(f"{base_stem}_v*{suffix}"):
        m2 = _VERSION_SUFFIX_RE.search(sibling.stem)
        if m2:
            try:
                existing_versions.append(int(m2.group(1)))
            except ValueError:
                pass

    next_n = (max(existing_versions) + 1) if existing_versions else 2
    return folder / f"{base_stem}_v{next_n}{suffix}"


def save_text(abs_path: Path, content: str) -> Path:
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(content, encoding="utf-8")
    return abs_path


def next_markup_path(rel_path: str) -> Path:
    """Compute the next `_markup_v<N>.md` filename for the given source file.

    Stripping `_v<N>` from the source stem so `foo_v3.md` and `foo.md` both
    map to a `foo_markup_v*.md` family. v1 is the first markup (markup files
    don't share v1 with the source — they live in their own version line)."""
    src = resolve_rel(rel_path)
    if not src.is_file():
        raise FileNotFoundError(rel_path)

    folder = src.parent
    stem = src.stem
    suffix = src.suffix

    m = _VERSION_SUFFIX_RE.search(stem)
    base_stem = stem[: m.start()] if m else stem
    target_stem_base = f"{base_stem}_markup"

    existing_versions: list[int] = []
    for sibling in folder.glob(f"{target_stem_base}_v*{suffix}"):
        m2 = _VERSION_SUFFIX_RE.search(sibling.stem)
        if m2:
            try:
                existing_versions.append(int(m2.group(1)))
            except ValueError:
                pass

    next_n = (max(existing_versions) + 1) if existing_versions else 1
    return folder / f"{target_stem_base}_v{next_n}{suffix}"
