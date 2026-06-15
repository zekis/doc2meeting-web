"""Backend pipeline — two OpenAI Agents (Reviewer + Editor) + TTS.

Reviewer agent: produces a short conversational critique of one paragraph.
                Can call `read_context_doc` to pull any context document the
                user has flagged for the open document.

Editor agent:   takes the paragraph plus the reviewer's critique and any
                user note, and emits a rewritten paragraph. Can also call
                `read_context_doc` to verify a fact before rewriting.

Both agents run locally via the openai-agents SDK (Responses API under the
hood). No hosted Assistants API state.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from agents import Agent, RunContextWrapper, Runner, function_tool
from agents.usage import Usage
from openai import OpenAI
from pydantic import BaseModel, Field
from pydub import AudioSegment
from sqlmodel import Session, select

from .doc.cleaner import clean
from .doc.parser import Section as DocSection, parse

from . import fs
from .db import engine
from .models import AppSettings


_AUDIO_DIR = Path(os.environ.get("AUDIO_DIR", "./data/audio")).resolve()
_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

_REVIEW_MODEL = os.environ.get("OPENAI_REVIEW_MODEL", "gpt-4o")
_EDITOR_MODEL = os.environ.get("OPENAI_EDITOR_MODEL", "gpt-4o")

# OpenAI pricing in USD per 1M units. Defaults match gpt-4o + gpt-4o-mini-tts
# at time of writing. Override per-deployment via env vars; bump these when
# pricing changes upstream.
_PRICE_LLM_INPUT_PER_1M = float(os.environ.get("OPENAI_LLM_INPUT_PER_1M", "2.50"))
_PRICE_LLM_OUTPUT_PER_1M = float(os.environ.get("OPENAI_LLM_OUTPUT_PER_1M", "10.00"))
_PRICE_TTS_CHARS_PER_1M = float(os.environ.get("OPENAI_TTS_PER_1M_CHARS", "0.60"))


def cost_usd(llm_input_tokens: int, llm_output_tokens: int, tts_chars: int) -> float:
    """Compute the USD cost of one review's usage given the configured prices."""
    return (
        (llm_input_tokens or 0) * _PRICE_LLM_INPUT_PER_1M / 1_000_000
        + (llm_output_tokens or 0) * _PRICE_LLM_OUTPUT_PER_1M / 1_000_000
        + (tts_chars or 0) * _PRICE_TTS_CHARS_PER_1M / 1_000_000
    )

# Cap each tool-call read so a single read can't blow the context window.
_CONTEXT_BYTES_PER_FILE = 80_000


PERSONAS: dict[str, str] = {
    "skeptical": (
        "You are an experienced engineering reviewer in a meeting. The narrator has just finished "
        "reading a paragraph of the document out loud. Respond directly, as a real reviewer would in "
        "conversation.\n\n"
        "Open by reacting to the narrator. Use a natural opening like \"OK, so that bit…\" or "
        "\"Right, on that one…\". Then in the same short turn:\n"
        "- Summarise the key point of the paragraph in one sentence.\n"
        "- Raise ONE concrete clarifying question, gap, inconsistency, or concern.\n"
        "- Hand the floor back with a brief signal to continue.\n\n"
        "Style rules:\n"
        "- Conversational meeting voice; 2 to 4 sentences total; never longer.\n"
        "- Do NOT use markdown, bullets, or headings — this will be read aloud.\n"
        "- Do NOT reference being an AI or this being a generated review.\n"
        "- Do NOT use the word \"noted\" — reserved for the narrator's acknowledgement.\n"
        "- If the paragraph contains a table or code summarised rather than read, acknowledge it briefly.\n"
        "- If you have no real concern, say so plainly and hand back. Do not invent issues."
    ),
    "summary": (
        "You are a friendly summariser in a meeting where a narrator is reading a long document aloud. "
        "After each paragraph the narrator reads, you respond conversationally.\n\n"
        "- Restate the paragraph's main point in plain words.\n"
        "- 2 to 3 sentences total. End with a short cue to move on.\n"
        "- Conversational; no markdown, no bullets — this will be spoken aloud.\n"
        "- Do not reference being an AI."
    ),
    "newcomer": (
        "You are a junior team member in a meeting where a narrator is reading a technical document "
        "aloud. After each paragraph, you ask ONE concrete beginner-friendly question about jargon, "
        "acronyms, or assumed context.\n\n"
        "- 2 to 3 sentences total — ask the question, briefly say why you'd want to know, signal "
        "you're ready to continue.\n"
        "- Conversational; no markdown — this will be spoken aloud.\n"
        "- If the paragraph is straightforward and needs no question, say so and signal to continue.\n"
        "- Do not reference being an AI."
    ),
}


_EDITOR_INSTRUCTIONS = (
    "You are a technical editor. You receive a paragraph from a long technical document, a "
    "reviewer's critique of that paragraph, and (optionally) a note from the document owner. "
    "Your job is to produce a single rewritten paragraph that addresses the critique while "
    "preserving the original meaning, structure, and tone of the surrounding document.\n\n"
    "Rules:\n"
    "- Preserve any formatting already in the original (lists stay as lists, tables stay as "
    "tables, code stays as code).\n"
    "- If you genuinely cannot improve the paragraph or the critique does not warrant a change, "
    "return the original paragraph verbatim as the replacement.\n"
    "- Never invent facts or numbers not present in the paragraph, the critique, the owner's note, "
    "or any context document you actively read.\n"
    "- If a reference document would help you verify a term, acronym, or fact before rewriting, "
    "open it via the read_context_doc tool. Don't open docs that are clearly unrelated.\n"
    "- The `replacement` field must contain ONLY the rewritten paragraph text — no commentary, "
    "no markdown fences. The `rationale` field is one sentence explaining what changed and why."
)


_RESPONDER_INSTRUCTIONS = (
    "You are the document's narrator/author in a meeting. You just finished reading a paragraph "
    "aloud and the reviewer has responded with a question, concern, or suggestion. Now respond "
    "to the reviewer briefly and conversationally, as a real author would in a meeting.\n\n"
    "Choose one:\n"
    "- If the critique is valid, acknowledge it concisely and indicate the change you intend.\n"
    "- If it's based on a misunderstanding of the text, clarify briefly without being defensive.\n"
    "- If it's a clarifying question you can answer directly, answer it briefly.\n"
    "- Then hand back so the meeting can continue.\n\n"
    "Style rules:\n"
    "- Conversational meeting voice; this will be read aloud by TTS.\n"
    "- 1 to 2 sentences total. Never longer.\n"
    "- No markdown, bullets, or headings.\n"
    "- Do not repeat the reviewer's question back to them.\n"
    "- Do not reference being an AI or that this is a generated reply.\n"
    "- Stay in character as the document's author throughout."
)


# ----------------- Rolling section history -----------------

@dataclass
class SectionHistoryEntry:
    """One prior paragraph in the current section, with its review thread.

    Passed into the reviewer/responder so they can see what's already been
    discussed in the section and avoid repeating earlier points.
    """

    paragraph_idx: int
    paragraph_text: str
    reviewer_comment: str | None = None
    narrator_response: str | None = None
    user_comment: str | None = None
    status: str = "pending"


def _format_document_outline(
    outline: list[tuple[int, int, str]] | None,
    current_section_idx: int | None,
) -> str:
    """Format the doc's section list (each entry: section_idx, level, title)
    for inclusion in an agent prompt. Marks the current section so the agent
    knows where it is, and reminds it to avoid duplicating fixes covered
    elsewhere in the doc."""
    if not outline:
        return ""
    lines = [
        "\n\nDocument outline — these sections already exist in this document. "
        "Before suggesting an addition or rewrite, check whether the topic is "
        "covered elsewhere. If it is, reference that section instead of "
        "duplicating the change here.\n\n",
    ]
    for idx, level, title in outline:
        indent = "  " * max(0, level - 1)
        marker = "  ← current section" if idx == current_section_idx else ""
        lines.append(f"{indent}- {title}{marker}\n")
    return "".join(lines)


def _format_section_history(history: list[SectionHistoryEntry] | None) -> str:
    if not history:
        return ""
    parts = [
        "\n\nPrior discussion in this section — the meeting has already covered "
        "the following paragraphs (in order). Use this for continuity and to "
        "avoid repeating earlier points.\n"
    ]
    for h in history:
        parts.append(f"\n— Paragraph {h.paragraph_idx + 1}:\n{h.paragraph_text}\n")
        if h.reviewer_comment:
            parts.append(f'  Reviewer said: "{h.reviewer_comment}"\n')
        if h.narrator_response:
            parts.append(f'  Narrator replied: "{h.narrator_response}"\n')
        if h.user_comment:
            parts.append(f"  (Owner note: {h.user_comment})\n")
        if h.status and h.status != "pending":
            parts.append(f"  Decision: {h.status}\n")
    return "".join(parts)


# ----------------- Agent shared context + tool -----------------

@dataclass
class AgentContext:
    """Per-invocation context handed to the SDK; carried into tool calls.

    `context_paths` is the whitelist of rel_paths the agent may read in this
    run. Anything outside it is rejected, even if the model attempts it.
    """

    context_paths: list[str] = field(default_factory=list)


@function_tool
def read_context_doc(ctx: RunContextWrapper[AgentContext], rel_path: str) -> str:
    """Read the body of a reference document that the user flagged as context
    for this review. Use this only when a specific reference would help. Pass
    the document's rel_path exactly as it appears in 'Available context
    documents' in your instructions.
    """
    allowed = ctx.context.context_paths if ctx.context else []
    if rel_path not in allowed:
        return (
            f"Refused: '{rel_path}' is not in the flagged context list for this "
            f"review. Available paths: {allowed or 'none'}."
        )
    try:
        body = fs.read_text(rel_path)
    except FileNotFoundError:
        return f"File '{rel_path}' no longer exists on disk."
    except ValueError as e:
        return f"Path error: {e}"
    if len(body.encode("utf-8")) > _CONTEXT_BYTES_PER_FILE:
        body = body[:_CONTEXT_BYTES_PER_FILE] + "\n\n[…truncated for token budget…]"
    return body


def _format_context_list(context_paths: list[str]) -> str:
    if not context_paths:
        return (
            "\n\nAvailable context documents: (none).\n"
            "The user has not flagged any reference documents for this review, so do not call "
            "the read_context_doc tool."
        )
    lines = "\n".join(f"  - {p}" for p in context_paths)
    return (
        f"\n\nAvailable context documents (you may call read_context_doc with any of these "
        f"rel_paths if it would meaningfully help you):\n{lines}\n"
    )


# ----------------- Reviewer agent -----------------

def _build_reviewer_agent(persona: str, context_paths: list[str]) -> Agent[AgentContext]:
    if persona not in PERSONAS:
        raise ValueError(f"Unknown persona '{persona}'.")
    instructions = PERSONAS[persona] + _format_context_list(context_paths)
    return Agent[AgentContext](
        name="Reviewer",
        instructions=instructions,
        tools=[read_context_doc],
        model=_REVIEW_MODEL,
    )


def review_paragraph(
    section_title: str,
    full_section_body: str,
    paragraph: str,
    context_paths: list[str] | None = None,
    persona: str = "skeptical",
    section_history: list[SectionHistoryEntry] | None = None,
    document_outline: list[tuple[int, int, str]] | None = None,
    current_section_idx: int | None = None,
) -> tuple[str, Usage]:
    """Run the reviewer agent against one paragraph; returns (critique, usage)."""
    paths = context_paths or []
    agent = _build_reviewer_agent(persona, paths)
    outline_block = _format_document_outline(document_outline, current_section_idx)
    history_block = _format_section_history(section_history)
    user_msg = (
        f'The narrator has just finished reading a paragraph from the section titled '
        f'"{section_title}". For context the full section is below; the specific paragraph '
        f"you should react to follows after.\n\n"
        f"FULL SECTION (context only):\n{full_section_body}\n"
        f"{outline_block}"
        f"{history_block}\n"
        f"PARAGRAPH JUST READ (react to this one):\n{paragraph}\n\n"
        f"Give your reviewer reaction now."
    )
    result = Runner.run_sync(
        agent,
        user_msg,
        context=AgentContext(context_paths=paths),
        max_turns=6,
    )
    out = result.final_output
    text = out.strip() if isinstance(out, str) else str(out).strip()
    return text, result.context_wrapper.usage


# ----------------- Narrator responder agent -----------------

def _build_responder_agent(context_paths: list[str]) -> Agent[AgentContext]:
    instructions = _RESPONDER_INSTRUCTIONS + _format_context_list(context_paths)
    return Agent[AgentContext](
        name="Narrator",
        instructions=instructions,
        tools=[read_context_doc],
        model=_REVIEW_MODEL,
    )


def narrator_respond(
    section_title: str,
    paragraph: str,
    reviewer_comment: str,
    context_paths: list[str] | None = None,
    section_history: list[SectionHistoryEntry] | None = None,
    document_outline: list[tuple[int, int, str]] | None = None,
    current_section_idx: int | None = None,
) -> tuple[str, Usage]:
    """Run the narrator responder agent. Returns (reply_text, usage)."""
    paths = context_paths or []
    agent = _build_responder_agent(paths)
    outline_block = _format_document_outline(document_outline, current_section_idx)
    history_block = _format_section_history(section_history)
    user_msg = (
        f'You are reading aloud from the section titled "{section_title}". '
        f"You just finished reading this paragraph:\n\n"
        f"{paragraph}\n\n"
        f"The reviewer responded:\n\n"
        f'"{reviewer_comment}"\n'
        f"{outline_block}"
        f"{history_block}\n"
        f"Now reply to the reviewer briefly so the meeting can move on."
    )
    result = Runner.run_sync(
        agent,
        user_msg,
        context=AgentContext(context_paths=paths),
        max_turns=6,
    )
    out = result.final_output
    text = out.strip() if isinstance(out, str) else str(out).strip()
    return text, result.context_wrapper.usage


# ----------------- Editor agent -----------------

class EditOutput(BaseModel):
    """Structured editor output. Pydantic-validated by the SDK."""

    replacement: str = Field(
        ...,
        description=(
            "The rewritten paragraph text only. No commentary, no markdown fences. "
            "Preserve any existing formatting (lists, tables, code). If no change is "
            "warranted, return the original paragraph verbatim."
        ),
    )
    rationale: str = Field(
        ...,
        description="One short sentence describing what changed and why.",
    )


def _build_editor_agent(context_paths: list[str]) -> Agent[AgentContext]:
    instructions = _EDITOR_INSTRUCTIONS + _format_context_list(context_paths)
    return Agent[AgentContext](
        name="Editor",
        instructions=instructions,
        tools=[read_context_doc],
        model=_EDITOR_MODEL,
        output_type=EditOutput,
    )


def propose_replacement(
    section_title: str,
    paragraph: str,
    reviewer_comment: str,
    user_comment: str | None,
    context_paths: list[str] | None = None,
    document_outline: list[tuple[int, int, str]] | None = None,
    current_section_idx: int | None = None,
) -> tuple[str, str, Usage]:
    """Run the editor agent. Returns (replacement_text, rationale, usage)."""
    paths = context_paths or []
    agent = _build_editor_agent(paths)
    outline_block = _format_document_outline(document_outline, current_section_idx)
    note_line = (
        f"Document owner's note: {user_comment.strip()}"
        if user_comment and user_comment.strip()
        else "Document owner's note: (none)"
    )
    user_msg = (
        f'Section title: "{section_title}"\n\n'
        f"Original paragraph:\n{paragraph}\n\n"
        f"Reviewer's critique:\n{reviewer_comment}\n\n"
        f"{note_line}\n"
        f"{outline_block}\n"
        f"Write the revised paragraph now."
    )
    result = Runner.run_sync(
        agent,
        user_msg,
        context=AgentContext(context_paths=paths),
        max_turns=6,
    )
    out = result.final_output
    usage = result.context_wrapper.usage
    if isinstance(out, EditOutput):
        return out.replacement.strip(), out.rationale.strip(), usage
    return str(out).strip(), "", usage


# ----------------- Parsing helpers (unchanged) -----------------

# Word's auto-generated TOC entries: `[1.2 Heading 5](#_Toc207704336)` etc.
_TOC_LINK_RE = re.compile(r"^\[.+?\]\(#_Toc\d+\)$")
# Standalone "Contents" heading or bold paragraph that prefaces the TOC.
_CONTENTS_HEADING_RE = re.compile(
    r"^(?:#+\s*)?(?:\*\*)?\s*contents\s*(?:\*\*)?\s*$", re.IGNORECASE
)


def strip_toc(markdown: str) -> str:
    """Remove auto-generated Word table-of-contents blocks from markdown.

    Drops:
    - Paragraphs whose every non-empty line is a `[text](#_TocNNN)` link.
    - A standalone `Contents` heading (h1-h6, bold, or plain) that precedes
      them — those anchor IDs don't exist as markdown headings anyway, so
      both the TOC and its label are noise in review mode.
    """
    parts = markdown.split("\n\n")
    kept: list[str] = []
    for p in parts:
        s = p.strip()
        if not s:
            continue
        if _CONTENTS_HEADING_RE.match(s):
            continue
        lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
        if lines and all(_TOC_LINK_RE.match(ln) for ln in lines):
            continue
        kept.append(p.rstrip())
    out = "\n\n".join(kept)
    return out + "\n" if out and not out.endswith("\n") else out


def _merge_empty_sections(sections: list[DocSection]) -> list[DocSection]:
    """Collapse heading-only sections so the section nav stays chapter-level
    and individual subheadings (OVERVIEW, SCOPE, …) ride inside the reviewable
    body instead of taking their own row.

    Two merging rules in priority order:

    1. **Child absorb.** When a section has no body but the sections that
       follow are deeper-level siblings, the parent absorbs all of them. Each
       child's heading becomes a bold lead-in line in the parent's body, and
       split_paragraphs' lead-in rule then re-merges those headings with the
       paragraph that follows them. Result: one nav entry per chapter, all
       subheadings live inside paragraphs.

    2. **Forward fold.** A heading-only section with no deeper children
       (rare — typically a trailing empty H1) gets prepended as a bold lead-in
       to the *next* non-empty section's body.

    The bold-line form survives a save_version round-trip without
    re-introducing new heading sections on re-parse.
    """
    out: list[DocSection] = []
    pending: list[str] = []  # rule 2: empties waiting for the next non-empty
    i = 0
    while i < len(sections):
        sec = sections[i]
        if sec.body.strip():
            # Substantive section — finalise any pending forward-fold first.
            if pending:
                prefix = "\n\n".join(f"**{t}**" for t in pending)
                out.append(
                    DocSection(
                        level=sec.level,
                        title=sec.title,
                        body=f"{prefix}\n\n{sec.body}",
                        full_path=sec.full_path,
                    )
                )
                pending = []
            else:
                out.append(sec)
            i += 1
            continue

        # Empty section — try child-absorb first.
        body_parts: list[str] = []
        j = i + 1
        while j < len(sections) and sections[j].level > sec.level:
            child = sections[j]
            t = child.title.strip()
            b = child.body.strip()
            body_parts.append(f"**{t}**\n\n{b}" if b else f"**{t}**")
            j += 1
        if body_parts:
            if pending:
                body_parts = [f"**{t}**" for t in pending] + body_parts
                pending = []
            out.append(
                DocSection(
                    level=sec.level,
                    title=sec.title,
                    body="\n\n".join(body_parts),
                    full_path=sec.full_path,
                )
            )
            i = j
        else:
            # No children to absorb — defer until the next non-empty section.
            pending.append(sec.title.strip())
            i += 1

    # Trailing empties (no following content) keep their own minimal row.
    for title in pending:
        out.append(DocSection(level=1, title=title, body="", full_path=title))
    return out


def _prepend_section_titles(sections: list[DocSection]) -> list[DocSection]:
    """Prepend each section's own title as a bold lead-in to its body.

    Combined with the heading-absorb rule in split_paragraphs, this makes
    sure the section title is part of a reviewable paragraph rather than a
    standalone heading row in the doc column (which you can't review)."""
    out: list[DocSection] = []
    for sec in sections:
        body = sec.body.strip()
        prefix = f"**{sec.title.strip()}**"
        new_body = f"{prefix}\n\n{body}" if body else prefix
        out.append(
            DocSection(
                level=sec.level,
                title=sec.title,
                body=new_body,
                full_path=sec.full_path,
            )
        )
    return out


def parse_markdown(markdown: str) -> list[DocSection]:
    return _prepend_section_titles(
        _merge_empty_sections(parse(strip_toc(markdown)))
    )


_BULLET_RE = re.compile(r"^\s*([-*+]|\d+[.)])\s")
# Single-line paragraph wrapped entirely in **...** or __...__ — Word output
# uses this for subheadings that didn't get a real markdown # marker.
_BOLD_LINE_RE = re.compile(r"^\s*(\*\*[^*\n]+\*\*|__[^_\n]+__)\s*$")
# Markdown ATX heading marker (H3+ — H1/H2 are section dividers in the parser
# and never reach split_paragraphs in body form, but we still match them
# defensively in case the body picks them up via prepended titles).
_HASH_HEADING_RE = re.compile(r"^\s*#{1,6}\s+\S")
# A paragraph that's just a markdown image reference, eg `![alt](url)`.
_IMAGE_ONLY_RE = re.compile(r"^\s*!\[[^\]]*\]\([^)]+\)\s*$")


def _starts_with_bullet(p: str) -> bool:
    """True when the paragraph's first non-blank line is a list item."""
    for line in p.splitlines():
        if line.strip():
            return bool(_BULLET_RE.match(line))
    return False


def _is_heading_like(p: str) -> bool:
    """A standalone subheading line — either a fully-bold line (`**Foo**`)
    or a markdown ATX heading (`### Foo`, `#### Foo`, …). Both visually act
    as subheadings inside a parent section's body."""
    lines = [ln for ln in p.splitlines() if ln.strip()]
    if len(lines) != 1:
        return False
    line = lines[0]
    return bool(_BOLD_LINE_RE.match(line)) or bool(_HASH_HEADING_RE.match(line))


_SHORT_LINE_WORD_LIMIT = 30
# Sentence-ending punctuation followed by whitespace or end-of-string. A
# digit-internal '.' (1.0, 2026-01-15) doesn't count.
_SENTENCE_END_RE = re.compile(r"[.!?](?:\s|$)")


def _is_short_single_line(p: str) -> bool:
    """A single non-blank line under 30 words that doesn't read like a
    finished sentence — covers cover-page entries like 'Document No: …',
    'Version 1.0', 'Date: …', and lead-in fragments.

    A short single line that DOES contain sentence-ending punctuation is
    treated as ordinary prose so it doesn't accidentally absorb everything
    that follows."""
    lines = [ln for ln in p.splitlines() if ln.strip()]
    if len(lines) != 1:
        return False
    line = lines[0]
    if len(line.split()) >= _SHORT_LINE_WORD_LIMIT:
        return False
    return not _SENTENCE_END_RE.search(line)


def _is_lead_in(p: str) -> bool:
    """A paragraph that should fold into whatever substantive content
    follows it — a subheading, or a short single-line fragment."""
    return _is_heading_like(p) or _is_short_single_line(p)


def _is_image_only(p: str) -> bool:
    """A paragraph that's just a markdown image — `![alt](url)` and nothing
    else. Visually renders as either an image or (with a data:URL we can't
    display) an empty cell. Either way it should ride with the surrounding
    text rather than being its own reviewable unit."""
    lines = [ln for ln in p.splitlines() if ln.strip()]
    if len(lines) != 1:
        return False
    return bool(_IMAGE_ONLY_RE.match(lines[0]))


def _is_table(p: str) -> bool:
    """A markdown table block — every non-blank line begins with `|`. Tables
    are inert reviewable content on their own; they belong with whatever
    paragraph introduces them ('The following table…')."""
    lines = [ln for ln in p.splitlines() if ln.strip()]
    if not lines:
        return False
    return all(ln.lstrip().startswith("|") for ln in lines)


def split_paragraphs(body: str) -> list[str]:
    """Split a section body into reviewable paragraphs.

    Starts with blank-line splitting, then re-merges so:
    - A subheading-like or short single-line paragraph folds forward into
      its next content paragraph. Consecutive lead-ins collapse together
      first (e.g. cover pages where every line is short).
    - A lead-in line + its bullet list reviews as one unit.

    Without this the agent sees these chunks in isolation and tends to
    review them as if disconnected.
    """
    parts = [p.strip() for p in body.split("\n\n")]
    parts = [p for p in parts if p]

    out: list[str] = []
    i = 0
    while i < len(parts):
        cur = parts[i]
        # A subheading pulls in any stacked headings + short fragments that
        # follow it and then exactly ONE substantive paragraph. The next
        # substantive paragraph in the section stands on its own — fine-
        # grained review units for the rest of the section's prose.
        if _is_heading_like(cur):
            while i + 1 < len(parts):
                nxt = parts[i + 1]
                cur = cur + "\n\n" + nxt
                i += 1
                if not _is_lead_in(nxt):
                    break
        # Now forward-absorb any trailing "fillers" — bullets, images, or
        # short caption lines — into whatever's currently in `cur`. Stops at
        # the next heading or substantive paragraph. This is what lets a
        # body paragraph keep its `![](image)` + `Figure N` caption attached
        # rather than spawning empty/orphan review units.
        while i + 1 < len(parts):
            nxt = parts[i + 1]
            if _is_heading_like(nxt):
                break
            if (
                _starts_with_bullet(nxt)
                or _is_image_only(nxt)
                or _is_table(nxt)
                or _is_short_single_line(nxt)
            ):
                cur = cur + "\n\n" + nxt
                i += 1
                continue
            break
        out.append(cur)
        i += 1
    return out


# ----------------- App settings (voices, tones, persona) -----------------

def get_current_settings() -> AppSettings:
    """Read the singleton AppSettings row, creating it on first call so
    defaults from the model class are persisted."""
    with Session(engine) as session:
        s = session.exec(select(AppSettings).limit(1)).first()
        if s is None:
            s = AppSettings()
            session.add(s)
            session.commit()
            session.refresh(s)
        return s


# ----------------- TTS synthesis -----------------

# OpenAI TTS client cached as it's expensive to construct.
_tts_client: OpenAI | None = None


def _get_tts_client() -> OpenAI:
    global _tts_client
    if _tts_client is None:
        _tts_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    return _tts_client


def _synth_to_file(
    text: str, voice: str, instructions: str | None, target: Path
) -> Path:
    """Render text → mp3 via OpenAI TTS using the supplied voice + steering."""
    if not text.strip():
        raise ValueError("Empty text.")
    settings = get_current_settings()
    params: dict = {
        "model": settings.tts_model,
        "voice": voice,
        "input": text,
        "response_format": "mp3",
    }
    if instructions and settings.tts_model == "gpt-4o-mini-tts":
        params["instructions"] = instructions
    client = _get_tts_client()
    with client.audio.speech.with_streaming_response.create(**params) as resp:
        mp3_bytes = b"".join(resp.iter_bytes())
    audio = AudioSegment.from_file(io.BytesIO(mp3_bytes), format="mp3")
    target.parent.mkdir(parents=True, exist_ok=True)
    audio.export(target, format="mp3")
    return target


def _para_path(document_id: int, section_idx: int, paragraph_idx: int, tag: str) -> Path:
    return _AUDIO_DIR / str(document_id) / f"s{section_idx}-p{paragraph_idx}-{tag}-{uuid4().hex[:6]}.mp3"


def synthesise_paragraph_narrator(
    paragraph: str, document_id: int, section_idx: int, paragraph_idx: int
) -> tuple[Path, int]:
    """Returns (path, chars_billed). UUID-named — always re-renders."""
    s = get_current_settings()
    cleaned = clean(paragraph) or paragraph
    path = _synth_to_file(
        cleaned,
        s.narrator_voice,
        s.narrator_instructions,
        _para_path(document_id, section_idx, paragraph_idx, "narrator"),
    )
    return path, len(cleaned)


def ensure_paragraph_narrator(
    paragraph: str, document_id: int, section_idx: int, paragraph_idx: int
) -> tuple[Path, int]:
    """Idempotent narrator TTS. Returns (path, chars_billed) where chars is 0
    when the cached file is reused — we don't double-charge for the same text.

    Names the file by a hash of (paragraph text + voice) so re-running 'Play
    all' re-uses the existing mp3; if the paragraph is edited OR the user
    picks a different voice in Settings the hash changes and we re-render."""
    s = get_current_settings()
    cleaned = clean(paragraph) or paragraph
    fingerprint = f"{cleaned}|{s.narrator_voice}|{s.tts_model}"
    text_hash = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:10]
    target = _AUDIO_DIR / str(document_id) / f"s{section_idx}-p{paragraph_idx}-narr-{text_hash}.mp3"
    if target.is_file():
        return target, 0
    _synth_to_file(cleaned, s.narrator_voice, s.narrator_instructions, target)
    return target, len(cleaned)


def synthesise_paragraph_reviewer(
    reviewer_comment: str, document_id: int, section_idx: int, paragraph_idx: int
) -> tuple[Path, int]:
    s = get_current_settings()
    path = _synth_to_file(
        reviewer_comment,
        s.reviewer_voice,
        s.reviewer_instructions,
        _para_path(document_id, section_idx, paragraph_idx, "reviewer"),
    )
    return path, len(reviewer_comment)


def synthesise_response_audio(
    response_text: str, document_id: int, section_idx: int, paragraph_idx: int
) -> tuple[Path, int]:
    s = get_current_settings()
    path = _synth_to_file(
        response_text,
        s.narrator_voice,
        s.responder_instructions,
        _para_path(document_id, section_idx, paragraph_idx, "response"),
    )
    return path, len(response_text)


def iter_response_tts(response_text: str) -> Generator[bytes, None, None]:
    """Stream raw MP3 chunks from OpenAI TTS for a meeting response.

    Skips pydub re-encoding — yields bytes directly from the API, which
    allows the caller to forward chunks to the client as they arrive.
    """
    if not response_text.strip():
        return
    s = get_current_settings()
    params: dict = {
        "model": s.tts_model,
        "voice": s.narrator_voice,
        "input": response_text,
        "response_format": "mp3",
    }
    if s.responder_instructions and s.tts_model == "gpt-4o-mini-tts":
        params["instructions"] = s.responder_instructions
    client = _get_tts_client()
    with client.audio.speech.with_streaming_response.create(**params) as resp:
        yield from resp.iter_bytes(chunk_size=4096)


def save_response_audio_bytes(
    mp3_bytes: bytes, document_id: int, section_idx: int, paragraph_idx: int,
) -> Path:
    """Write raw MP3 bytes to the standard audio path and return it."""
    target = _para_path(document_id, section_idx, paragraph_idx, "response")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(mp3_bytes)
    return target


def relative_audio_path(absolute: Path) -> str:
    try:
        return absolute.resolve().relative_to(_AUDIO_DIR).as_posix()
    except ValueError:
        return absolute.name
