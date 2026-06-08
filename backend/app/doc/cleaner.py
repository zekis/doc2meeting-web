"""Clean markdown text for text-to-speech rendering.

Goals:
- Strip syntax noise (link URLs, image refs, raw markdown markers).
- Replace code blocks and tables with short spoken summaries — reading them
  verbatim is torture, but skipping silently loses context.
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


def _summarise_one_table(header_cells: list[str], body_rows: list[list[str]]) -> str:
    """Produce a spoken-meeting-style sentence describing a markdown table.

    Recognises three patterns common in SAT specs:
    - Step table: header is Step | Action | Expected Result | ...
    - Test header form: empty header, body rows lead with Purpose / Test Cases / etc.
    - Generic reference table: anything else.

    Tables are NOT read out cell by cell. The reviewer still sees the raw markdown
    via the section body and can comment on specifics if anything stands out.
    """
    row_count = len(body_rows)
    header_lower = [c.lower() for c in header_cells]

    is_step_table = (
        len(header_cells) >= 5
        and "step" in header_lower
        and any("action" in c for c in header_lower)
        and any("expected" in c for c in header_lower)
    )
    if is_step_table:
        return f"(The test has {row_count} steps.)"

    # Test header form: empty header row, first body cell is "Purpose" / similar.
    test_header_keys = {
        "purpose", "test cases executed", "special requirements",
        "initialization", "version of test items",
        "details of test environment particular to this test case",
        "estimated time for completion",
    }
    first_col_labels = [(r[0] or "").strip().lower() for r in body_rows if r]
    looks_like_test_header = (
        (not header_cells or all(not c for c in header_cells))
        and sum(1 for lbl in first_col_labels if lbl in test_header_keys) >= 3
    )
    if looks_like_test_header:
        return "(The test header form follows, covering purpose, test cases, special requirements, initialization, version of test items, environment details and estimated time.)"

    # Generic reference table.
    named = [c for c in header_cells if c]
    if named:
        col_list = ", ".join(named[:5])
        extra = f" and {len(named) - 5} more columns" if len(named) > 5 else ""
        return f"(A {row_count}-row reference table follows, with columns: {col_list}{extra}.)"
    return f"(A {row_count}-row table follows.)"


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
            out.append(_summarise_one_table(header_cells, body_rows))
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
