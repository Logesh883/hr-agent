"""Splitting a policy into chunks: the unit that is embedded, retrieved and cited.

Two chunkers, so A4.5 can measure the difference:

- `heading` (structure-aware, the default): a chunk never crosses a section boundary, so
  every chunk has one section to cite. Inside a section, whole blocks (a paragraph, a list,
  a table) are packed up to the target size. A block that is too big on its own is split
  between list items or table rows (the table's header row is repeated on every piece, so
  a row never loses its column names), and a long paragraph between sentences. Consecutive
  chunks of a section overlap by a block or two (about 1/8 of the size).
- `fixed`: a sliding window over the words, ignoring structure, with the same overlap. It
  cuts tables and rules in half; that's the point of comparing.

Sizes are in approximate tokens (`approx_tokens`: about 4 characters per token for English).
The embedding provider has its own tokenizer; the chunker only needs a consistent ruler.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

Chunker = Literal["heading", "fixed"]

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")
_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+(.+)$")


def approx_tokens(text: str) -> int:
    return max(1, round(len(text) / 4))


@dataclass(frozen=True)
class Chunk:
    index: int
    # ("Leave Policy (v2)", "1. Entitlements"): the document title, then each heading level.
    heading_path: tuple[str, ...]
    content: str
    token_count: int

    @property
    def section(self) -> str:
        """The innermost heading below the title ("" for text before the first section)."""
        return self.heading_path[-1] if len(self.heading_path) > 1 else ""


def chunk(text: str, *, chunker: Chunker = "heading", size: int = 256) -> list[Chunk]:
    if chunker == "heading":
        return chunk_by_heading(text, size=size)
    return chunk_fixed(text, size=size)


def section_label(section: str) -> str:
    """`1. Entitlements` → `§1 Entitlements`; unnumbered headings stay as they are."""
    match = _NUMBERED.match(section)
    return f"§{match.group(1)} {match.group(2)}" if match else section


# ---- Structure-aware ---------------------------------------------------------------------


@dataclass(frozen=True)
class _Unit:
    """A piece that is never split further, and how it joins the piece before it."""

    text: str
    joiner: str


def chunk_by_heading(text: str, *, size: int, overlap: int | None = None) -> list[Chunk]:
    overlap = size // 8 if overlap is None else overlap
    chunks: list[Chunk] = []
    for path, body in _sections(text):
        units = [unit for block in _blocks(body) for unit in _split_block(block, size)]
        for content in _pack(units, size, overlap):
            chunks.append(Chunk(len(chunks), path, content, approx_tokens(content)))
    return chunks


def _sections(text: str) -> Iterable[tuple[tuple[str, ...], str]]:
    """(heading path, body) for every heading, in order; empty bodies are skipped."""
    stack: list[tuple[int, str]] = []
    lines: list[str] = []

    def flush() -> Iterable[tuple[tuple[str, ...], str]]:
        body = "\n".join(lines).strip()
        if body:
            yield tuple(title for _, title in stack) or ("",), body

    for line in text.splitlines():
        match = _HEADING.match(line)
        if not match:
            lines.append(line)
            continue
        yield from flush()
        lines = []
        level = len(match.group(1))
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, match.group(2)))
    yield from flush()


def _blocks(body: str) -> list[str]:
    """Paragraphs, lists and tables: runs of non-blank lines."""
    return [block.strip() for block in re.split(r"\n\s*\n", body) if block.strip()]


def _split_block(block: str, size: int) -> list[_Unit]:
    if approx_tokens(block) <= size:
        return [_Unit(block, "\n\n")]
    lines = block.splitlines()
    if len(lines) > 1 and lines[0].lstrip().startswith("|"):
        return _split_table(lines, size)
    if len(lines) > 1:
        # A list (maybe with an intro line): one unit per line, so items stay whole.
        return [_Unit(line, "\n\n" if i == 0 else "\n") for i, line in enumerate(lines)]
    sentences = _SENTENCE_END.split(block)
    return [_Unit(s, "\n\n" if i == 0 else " ") for i, s in enumerate(sentences)]


def _split_table(lines: list[str], size: int) -> list[_Unit]:
    """Groups of rows, each with the header and separator rows in front."""
    header, rows = lines[:2], lines[2:]
    units: list[_Unit] = []
    group: list[str] = []
    for row in rows:
        if group and approx_tokens("\n".join([*header, *group, row])) > size:
            units.append(_Unit("\n".join([*header, *group]), "\n\n"))
            group = []
        group.append(row)
    if group:
        units.append(_Unit("\n".join([*header, *group]), "\n\n"))
    return units


def _pack(units: list[_Unit], size: int, overlap: int) -> list[str]:
    """Greedy: add units until the next would overflow, then start a new chunk that repeats
    the last units (up to `overlap` tokens) for context."""
    chunks: list[str] = []
    current: list[_Unit] = []
    fresh = 0  # units in `current` that haven't been emitted yet
    for unit in units:
        if current and approx_tokens(_join([*current, unit])) > size and fresh:
            chunks.append(_join(current))
            current = _tail(current, overlap)
            fresh = 0
        current.append(unit)
        fresh += 1
    if current and fresh:
        chunks.append(_join(current))
    return chunks


def _tail(units: list[_Unit], overlap: int) -> list[_Unit]:
    """The last units totalling at most `overlap` tokens, never the whole chunk."""
    tail: list[_Unit] = []
    for unit in reversed(units[1:]):
        if approx_tokens(_join([unit, *tail])) > overlap:
            break
        tail.insert(0, unit)
    return tail


def _join(units: list[_Unit]) -> str:
    if not units:
        return ""
    return units[0].text + "".join(unit.joiner + unit.text for unit in units[1:])


# ---- Fixed-size --------------------------------------------------------------------------


def chunk_fixed(text: str, *, size: int, overlap: int | None = None) -> list[Chunk]:
    """Windows of about `size` tokens over the words, each starting `overlap` tokens before
    the previous one ended. Each chunk is labelled with the heading in force where it starts."""
    overlap = size // 8 if overlap is None else overlap
    budget, overlap_budget = size * 4, overlap * 4  # in characters, like approx_tokens
    words = list(re.finditer(r"\S+", text))
    headings = _heading_offsets(text)
    chunks: list[Chunk] = []
    start = 0
    while start < len(words):
        end = start + 1
        while end < len(words) and words[end].end() - words[start].start() <= budget:
            end += 1
        content = text[words[start].start() : words[end - 1].end()]
        path = _path_at(headings, words[start].start())
        chunks.append(Chunk(len(chunks), path, content, approx_tokens(content)))
        if end == len(words):
            break
        back = end
        while back - 1 > start and words[end - 1].end() - words[back - 1].start() <= overlap_budget:
            back -= 1
        start = back
    return chunks


def _heading_offsets(text: str) -> list[tuple[int, tuple[str, ...]]]:
    """(character offset, heading path in force from there) for every heading."""
    offsets: list[tuple[int, tuple[str, ...]]] = []
    stack: list[tuple[int, str]] = []
    position = 0
    for line in text.splitlines(keepends=True):
        match = _HEADING.match(line.rstrip("\n"))
        if match:
            level = len(match.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, match.group(2)))
            offsets.append((position, tuple(title for _, title in stack)))
        position += len(line)
    return offsets


def _path_at(headings: list[tuple[int, tuple[str, ...]]], offset: int) -> tuple[str, ...]:
    path: tuple[str, ...] = ("",)
    for start, heading_path in headings:
        if start > offset:
            break
        path = heading_path
    return path
