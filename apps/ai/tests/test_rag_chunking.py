from rag.chunking import approx_tokens, chunk, chunk_by_heading, chunk_fixed, section_label

POLICY = """# Leave Policy (v2)

Effective 1 January 2026. Replaces version 1.

## 1. Entitlements
| Type | Days per calendar year |
| --- | --- |
| Annual leave | 18 |
| Sick leave | 12 |
| Casual leave | 6 |
| Unpaid leave | No limit (subject to approval) |

Unused leave does not carry over to the next year.

## 2. Approval
- Leave is approved by the employee's direct manager.
- Nobody approves their own leave.
- A rejection must include a reason, which the employee can see.

### 2.1 Escalation
HR approves when the manager is unavailable.
"""


def test_heading_chunks_follow_sections_and_record_the_path() -> None:
    chunks = chunk_by_heading(POLICY, size=256)

    assert [c.heading_path for c in chunks] == [
        ("Leave Policy (v2)",),
        ("Leave Policy (v2)", "1. Entitlements"),
        ("Leave Policy (v2)", "2. Approval"),
        ("Leave Policy (v2)", "2. Approval", "2.1 Escalation"),
    ]
    assert [c.section for c in chunks] == ["", "1. Entitlements", "2. Approval", "2.1 Escalation"]
    assert [c.index for c in chunks] == [0, 1, 2, 3]
    # Headings are metadata, not content; the table and the sentence after it stay together.
    entitlements = chunks[1].content
    assert "#" not in entitlements
    assert entitlements.startswith("| Type |") and entitlements.endswith("next year.")
    assert all(c.token_count == approx_tokens(c.content) for c in chunks)


def test_a_chunk_never_crosses_a_section_even_when_both_fit() -> None:
    chunks = chunk_by_heading(POLICY, size=10_000)

    assert len(chunks) == 4


def test_an_oversized_table_is_split_between_rows_with_the_header_repeated() -> None:
    chunks = chunk_by_heading(POLICY, size=30)
    tables = [c.content for c in chunks if c.content.startswith("| Type |")]

    assert len(tables) >= 2
    for table in tables:
        assert table.splitlines()[1] == "| --- | --- |"
    rows = [line for table in tables for line in table.splitlines()[2:]]
    # Every row appears, whole (overlap may repeat one), and no row is cut in half.
    assert {line for line in rows} == {
        "| Annual leave | 18 |",
        "| Sick leave | 12 |",
        "| Casual leave | 6 |",
        "| Unpaid leave | No limit (subject to approval) |",
    }


def test_lists_split_between_items_and_consecutive_chunks_overlap() -> None:
    text = "# P\n\n## Rules\n" + "\n".join(f"- Rule number {i} says something." for i in range(12))

    chunks = chunk_by_heading(text, size=40, overlap=10)

    assert len(chunks) > 1
    for chunk_ in chunks:
        assert all(line.startswith("- Rule number") for line in chunk_.content.splitlines())
    # The next chunk starts with the last item of the previous one.
    assert chunks[1].content.splitlines()[0] == chunks[0].content.splitlines()[-1]


def test_a_long_paragraph_splits_between_sentences() -> None:
    sentence = "Employees must record their attendance every working day without exception."
    text = "# P\n\n" + " ".join([sentence] * 12)

    chunks = chunk_by_heading(text, size=50)

    assert len(chunks) > 1
    assert all(c.content.endswith(".") for c in chunks)


def test_fixed_chunks_ignore_structure_but_keep_the_heading_where_they_start() -> None:
    chunks = chunk_fixed(POLICY, size=32, overlap=4)

    assert len(chunks) > 3
    assert all(c.token_count <= 32 for c in chunks)
    assert chunks[0].content.startswith("# Leave Policy (v2)")
    assert any(c.section == "2. Approval" for c in chunks)
    # Windows overlap: each one starts before the previous one ended.
    first_words = chunks[1].content.split()[:2]
    assert " ".join(first_words) in chunks[0].content


def test_chunk_dispatches_on_the_chunker_name() -> None:
    assert chunk(POLICY, chunker="heading", size=256) == chunk_by_heading(POLICY, size=256)
    assert chunk(POLICY, chunker="fixed", size=64) == chunk_fixed(POLICY, size=64)


def test_section_labels() -> None:
    assert section_label("1. Entitlements") == "§1 Entitlements"
    assert section_label("2.1 Escalation") == "§2.1 Escalation"
    assert section_label("Late arrival") == "Late arrival"
