"""Markdown chunker -- IMPLEMENTATION.md section 8.2: 400 tokens with 80-token
overlap, split on markdown headings first then paragraphs, never split a table or
a numbered protocol across chunks, prepend heading_path before embedding.

"Tokens" here are word-count, not BPE -- a deliberate approximation. The embedding
model (rag/embedder.py) does its own real tokenization internally; this chunker
only needs a stable, cheap proxy for "roughly how much text is in this chunk" to
hit the target size, not an exact token budget.
"""

import re
from dataclasses import dataclass

TARGET_WORDS = 400
OVERLAP_WORDS = 80

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_TABLE_LINE_RE = re.compile(r"^\s*\|.*\|\s*$")
_NUMBERED_LINE_RE = re.compile(r"^\s*\d+[.)]\s+")


@dataclass
class Chunk:
    content: str
    heading_path: str


def _word_count(text: str) -> int:
    return len(text.split())


def _split_into_blocks(body: str) -> list[str]:
    """Paragraphs, but a markdown table or a run of numbered-list lines is kept as
    one atomic block regardless of size -- splitting either mid-structure produces
    unreadable, half-meaningful chunks."""
    lines = body.split("\n")
    blocks: list[str] = []
    current: list[str] = []
    mode = "prose"  # "prose" | "table" | "numbered"

    def flush():
        if current:
            blocks.append("\n".join(current).strip())
            current.clear()

    for line in lines:
        is_table = bool(_TABLE_LINE_RE.match(line))
        is_numbered = bool(_NUMBERED_LINE_RE.match(line))
        blank = not line.strip()

        if is_table:
            if mode != "table":
                flush()
                mode = "table"
            current.append(line)
        elif is_numbered:
            if mode != "numbered":
                flush()
                mode = "numbered"
            current.append(line)
        elif blank:
            if mode in ("table", "numbered"):
                # A blank line ends a numbered run but tables can have trailing
                # blank rows in source markdown -- treat any blank as a hard break.
                flush()
                mode = "prose"
            else:
                flush()
        else:
            if mode in ("table", "numbered"):
                flush()
                mode = "prose"
            current.append(line)

    flush()
    return [b for b in blocks if b]


def _sections(markdown: str) -> list[tuple[str, str]]:
    """Splits on headings, returning [(heading_path, section_body), ...]. Content
    before the first heading gets an empty heading_path."""
    lines = markdown.split("\n")
    sections: list[tuple[str, str]] = []
    stack: list[tuple[int, str]] = []  # (level, title)
    current_body: list[str] = []

    def current_path() -> str:
        return " > ".join(title for _, title in stack)

    def flush():
        body = "\n".join(current_body).strip()
        if body:
            sections.append((current_path(), body))
        current_body.clear()

    for line in lines:
        m = _HEADING_RE.match(line)
        if m:
            flush()
            level, title = len(m.group(1)), m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        else:
            current_body.append(line)
    flush()
    return sections


def chunk_markdown(markdown: str) -> list[Chunk]:
    chunks: list[Chunk] = []

    for heading_path, body in _sections(markdown):
        blocks = _split_into_blocks(body)
        current_words: list[str] = []
        current_word_count = 0

        def flush_chunk():
            if current_words:
                content = " ".join(current_words).strip()
                if content:
                    chunks.append(Chunk(content=content, heading_path=heading_path))

        for block in blocks:
            block_word_count = _word_count(block)

            # A block bigger than the whole target size still can't be split
            # (table/numbered-list protection) -- it becomes its own chunk.
            if block_word_count > TARGET_WORDS:
                flush_chunk()
                current_words, current_word_count = [], 0
                chunks.append(Chunk(content=block.strip(), heading_path=heading_path))
                continue

            if current_word_count + block_word_count > TARGET_WORDS and current_words:
                flush_chunk()
                # Carry the last OVERLAP_WORDS words forward as context.
                overlap_source = " ".join(current_words).split()
                overlap = overlap_source[-OVERLAP_WORDS:] if len(overlap_source) > OVERLAP_WORDS else overlap_source
                current_words = list(overlap)
                current_word_count = len(current_words)

            current_words.append(block)
            current_word_count += block_word_count

        flush_chunk()

    return chunks
