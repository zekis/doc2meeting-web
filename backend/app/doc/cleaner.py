"""Clean markdown text for text-to-speech rendering.

Goals:
- Strip syntax noise (link URLs, image refs, raw markdown markers).
- Convert tables into natural spoken prose (column: value pairs per row) so
  the listener hears the actual data, not just a summary.
- Replace code blocks with short spoken summaries — reading them verbatim
  is torture, but skipping silently loses context.
- Expand alphanumeric identifiers (`ST3P`, `RC4P`) into spell-out form so the
  TTS engine pronounces them as letters + numbers instead of guessing.
- Preserve sentence structure and paragraph breaks (the narrator's pacing
  depends on punctuation).
"""

from __future__ import annotations

import re


_FENCED_CODE_RE = re.compile(r"```[a-zA-Z0-9_+-]*\n(.*?)\n```", re.DOTALL)
_INDENTED_CODE_RE = re.compile(r"(?m)^(?: {4}|\t).+$(?:\n(?: {4}|\t).+)*")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*|__([^_]+)__")
_ITALIC_RE = re.compile(r"(?<![*_])[*_]([^*_\n]+)[*_](?![*_])")
_HORIZONTAL_RULE_RE = re.compile(r"(?m)^[-*_]{3,}\s*$")
_HEADING_PREFIX_RE = re.compile(r"(?m)^#{1,6}\s+")
_LIST_MARKER_RE = re.compile(r"(?m)^[\s]*(?:[-*+]|\d+\.)\s+")
_FOOTNOTE_RE = re.compile(r"\[\^[^\]]+\]")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_TABLE_LINE_RE = re.compile(r"(?m)^\s*\|.+\|\s*$")
_TABLE_SEPARATOR_RE = re.compile(r"(?m)^\s*\|[-:\s|]+\|\s*$")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")

# Identifiers that benefit from spell-out:
# - Mixed letter+digit tokens of 2-8 chars, all caps: ST3P, RC4P, CD3P, SL2, RTC, TMS, QMS, ACS
# - Pure-letter abbreviations of 2-5 caps: TMS, QMS — TTS usually handles these OK, leave them.
_IDENT_RE = re.compile(r"\b([A-Z]{1,5}\d+[A-Z0-9]*)\b")


def _replace_code_blocks(text: str) -> str:
    def sub(match: re.Match[str]) -> str:
        code = match.group(1).strip()
        line_count = code.count("\n") + 1
        # Parentheses, not brackets — podvoice's parser treats line-leading
        # `[X]` as a speaker block.
        return f"\n(A {line_count}-line code block follows in the source document.)\n"

    text = _FENCED_CODE_RE.sub(sub, text)
    # Indented code is harder to detect reliably; skip for now.
    return text


def _read_table(header_cells: list[str], body_rows: list[list[str]]) -> str:
    """Convert a markdown table into natural spoken prose.

    Reads each row aloud using "column-name: value" pairs so the listener
    can follow along without seeing the table visually.  Skips empty cells
    and adapts phrasing based on table shape:
    - Key-value tables (2 cols, first col looks like a label): reads as "Key is Value."
    - Step/numbered tables: reads as "Step N. Column: value, Column: value."
    - General tables: reads each row with column labels.
    """
    row_count = len(body_rows)
    named = [c for c in header_cells if c.strip()]

    # -- Key-value table (2 columns, first column is labels) --
    if len(header_cells) == 2 and row_count >= 2:
        first_col_words = sum(1 for r in body_rows if r and r[0].strip())
        if first_col_words >= row_count * 0.8:
            parts: list[str] = []
            for row in body_rows:
                key = (row[0] if row else "").strip()
                val = (row[1] if len(row) > 1 else "").strip()
                if key and val:
                    parts.append(f"{key}: {val}.")
                elif key:
                    parts.append(f"{key}.")
            if parts:
                return "\n".join(parts)

    # -- Step / numbered first column --
    header_lower = [c.lower().strip() for c in header_cells]
    has_step_col = any(h in ("step", "#", "no", "no.", "number") for h in header_lower)

    lines: list[str] = []
    for row_idx, row in enumerate(body_rows):
        row_parts: list[str] = []
        for col_idx, cell in enumerate(row):
            cell_text = cell.strip()
            if not cell_text or cell_text == "-":
                continue
            col_name = header_cells[col_idx].strip() if col_idx < len(header_cells) else ""
            if has_step_col and col_idx == 0:
                row_parts.append(f"Step {cell_text}.")
            elif col_name:
                row_parts.append(f"{col_name}: {cell_text}.")
            else:
                row_parts.append(f"{cell_text}.")
        if row_parts:
            lines.append(" ".join(row_parts))

    if not lines:
        if named:
            col_list = ", ".join(named[:5])
            return f"(A {row_count}-row table with columns: {col_list}.)"
        return f"(A {row_count}-row table follows.)"

    # Intro line for context
    if named:
        col_list = ", ".join(named[:5])
        extra = f" and {len(named) - 5} more" if len(named) > 5 else ""
        intro = f"Table with {row_count} rows. Columns: {col_list}{extra}."
    else:
        intro = f"Table with {row_count} rows."

    return intro + "\n" + "\n".join(lines)


def _summarise_tables(text: str) -> str:
    """Replace contiguous markdown tables with a one-line spoken summary."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "|" in line and i + 1 < len(lines) and _TABLE_SEPARATOR_RE.match(lines[i + 1] or ""):
            header_cells = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2  # skip header and separator
            body_rows: list[list[str]] = []
            while i < len(lines) and _TABLE_LINE_RE.match(lines[i] or ""):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                body_rows.append(cells)
                i += 1
            out.append(_read_table(header_cells, body_rows))
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _expand_identifiers(text: str) -> str:
    """ST3P -> 'S T 3 P' so TTS spells it out."""
    def sub(m: re.Match[str]) -> str:
        token = m.group(1)
        spaced = " ".join(token)
        return spaced
    return _IDENT_RE.sub(sub, text)


def clean(text: str, expand_identifiers: bool = True) -> str:
    """Convert markdown body text into speakable prose."""
    text = _summarise_tables(text)
    text = _replace_code_blocks(text)
    text = _IMAGE_RE.sub(r"(Image: \1)", text)
    text = _LINK_RE.sub(r"\1", text)         # drop URL, keep label
    text = _INLINE_CODE_RE.sub(r"\1", text)  # drop backticks
    text = _BOLD_RE.sub(lambda m: m.group(1) or m.group(2), text)
    text = _ITALIC_RE.sub(r"\1", text)
    text = _HEADING_PREFIX_RE.sub("", text)  # any H3+ headings become plain sentences
    text = _LIST_MARKER_RE.sub("", text)
    text = _FOOTNOTE_RE.sub("", text)
    text = _HTML_TAG_RE.sub("", text)
    text = _HORIZONTAL_RULE_RE.sub("", text)
    if expand_identifiers:
        text = _expand_identifiers(text)
    text = _MULTI_BLANK_RE.sub("\n\n", text)
    return text.strip()
