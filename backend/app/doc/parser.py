"""Parse a Markdown document into a flat list of sections.

A section is a heading + the prose, code, and tables that follow it until the
next heading at the same or higher level. Headings deeper than H2 are kept
inside their parent H2's content (no H3-level episodes).
"""

from __future__ import annotations

import re
from dataclasses import dataclass


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


@dataclass
class Section:
    level: int           # 1 for H1, 2 for H2
    title: str           # heading text, markdown stripped
    body: str            # raw markdown after the heading, before the next H1/H2
    word_count: int = 0
    full_path: str = ""  # "H1 title / H2 title" — for episode naming

    def __post_init__(self) -> None:
        if not self.word_count:
            self.word_count = len(self.body.split()) + len(self.title.split())


def parse(markdown: str) -> list[Section]:
    """Split a markdown document into H1/H2-rooted sections.

    Each Section's body contains everything from after its heading line up to
    (but not including) the next H1 or H2 line. H3+ headings, code blocks,
    and tables stay inside the parent section's body.
    """
    sections: list[Section] = []
    current_h1: str | None = None

    matches = list(HEADING_RE.finditer(markdown))
    boundary_indices: list[tuple[int, int, int, str]] = []
    for m in matches:
        level = len(m.group(1))
        if level <= 2:
            boundary_indices.append((m.start(), m.end(), level, m.group(2).strip()))

    if not boundary_indices:
        # No H1 or H2 — treat whole doc as a single untitled section.
        sections.append(Section(level=1, title="Document", body=markdown.strip()))
        return sections

    # If there's content before the first heading, prepend it as an "Introduction" section.
    first_start = boundary_indices[0][0]
    preamble = markdown[:first_start].strip()
    if preamble:
        sections.append(Section(level=1, title="Introduction", body=preamble, full_path="Introduction"))

    for i, (h_start, h_end, level, title) in enumerate(boundary_indices):
        next_start = boundary_indices[i + 1][0] if i + 1 < len(boundary_indices) else len(markdown)
        body = markdown[h_end:next_start].strip()
        if level == 1:
            current_h1 = title
            full_path = title
        else:
            full_path = f"{current_h1} / {title}" if current_h1 else title
        sections.append(Section(level=level, title=title, body=body, full_path=full_path))

    return sections
