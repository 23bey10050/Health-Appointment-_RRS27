"""Unit tests for the markdown chunker (rag/chunker.py) -- no DB, no embedding
model, pure text-in/Chunk-out. IMPLEMENTATION.md section 8.2: 400-word target,
80-word overlap, headings tracked into heading_path, tables and numbered lists
never split mid-structure.
"""

from app.rag.chunker import chunk_markdown


def test_heading_path_tracks_nesting():
    md = """# Top
## Middle
### Deep
Some content here.
"""
    chunks = chunk_markdown(md)
    assert len(chunks) == 1
    assert chunks[0].heading_path == "Top > Middle > Deep"
    assert "Some content here." in chunks[0].content


def test_sibling_headings_reset_path_correctly():
    md = """# A
## A1
content one
## A2
content two
# B
content three
"""
    chunks = chunk_markdown(md)
    paths = {c.heading_path: c.content for c in chunks}
    assert "A > A1" in paths
    assert "A > A2" in paths
    assert "B" in paths
    assert "content three" in paths["B"]


def test_table_is_never_split_across_chunks():
    header = "# Fees\n"
    table = "\n".join(
        ["| Doctor | Fee |", "|---|---|"] + [f"| Dr. {i} | {i * 100} |" for i in range(60)]
    )
    md = header + table
    chunks = chunk_markdown(md)
    table_chunks = [c for c in chunks if "| Doctor | Fee |" in c.content]
    assert len(table_chunks) == 1
    assert all(f"Dr. {i}" in table_chunks[0].content for i in range(60))


def test_numbered_protocol_is_never_split_across_chunks():
    header = "# Protocol\n"
    steps = "\n".join(f"{i}. Step number {i} with some descriptive filler text." for i in range(1, 80))
    md = header + steps
    chunks = chunk_markdown(md)
    protocol_chunks = [c for c in chunks if "Step number 1 " in c.content]
    assert len(protocol_chunks) == 1
    assert "Step number 79" in protocol_chunks[0].content


def test_long_prose_splits_with_overlap():
    header = "# Long Section\n"
    paragraphs = "\n\n".join(f"Paragraph {i} has several words in it to pad out the length." for i in range(60))
    md = header + paragraphs
    chunks = chunk_markdown(md)

    assert len(chunks) > 1
    # Overlap: the tail of chunk N should reappear at the head of chunk N+1.
    first_tail_words = chunks[0].content.split()[-10:]
    second_head_words = chunks[1].content.split()[:30]
    assert any(w in second_head_words for w in first_tail_words)


def test_empty_input_produces_no_chunks():
    assert chunk_markdown("") == []
    assert chunk_markdown("# Just a heading\n\n") == []


def test_heading_path_prepended_is_caller_responsibility_not_chunker():
    # The chunker returns heading_path separately; ingest.py prepends it before
    # embedding/storage (section 8.2). Confirm the chunker itself doesn't duplicate it.
    md = "# Policy\nDo not double the heading text."
    chunks = chunk_markdown(md)
    assert chunks[0].content.count("Policy") == 0
