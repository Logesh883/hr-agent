"""Policy files → Markdown-like text the chunker understands (`#` headings, `|` tables, `-` lists).

Markdown and plain text pass through. DOCX keeps its structure: "Heading N" styles become
`#` headings, list styles become `-` items and tables become Markdown tables. PDF has no
structure to keep, only a text layer (`pypdf`); a scanned PDF without one is refused rather
than indexed as nothing (OCR arrives in M9).
"""

from io import BytesIO

from docx import Document as open_docx
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader


class UnsupportedPolicyFile(Exception):
    """The file can't be turned into text (unknown type, or a PDF with no text layer)."""


def to_text(data: bytes, *, mime_type: str, file_name: str) -> str:
    kind = _kind(mime_type, file_name)
    if kind == "markdown":
        return data.decode("utf-8-sig")
    if kind == "pdf":
        return _pdf_text(data)
    return _docx_text(data)


def _kind(mime_type: str, file_name: str) -> str:
    mime = mime_type.split(";", 1)[0].strip().lower()
    name = file_name.lower()
    if mime in ("text/markdown", "text/plain") or name.endswith((".md", ".txt")):
        return "markdown"
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if "wordprocessingml" in mime or name.endswith(".docx"):
        return "docx"
    raise UnsupportedPolicyFile(f"Can't read {file_name} ({mime_type}).")


def _pdf_text(data: bytes) -> str:
    reader = PdfReader(BytesIO(data))
    text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
    if not text:
        raise UnsupportedPolicyFile("The PDF has no text layer (a scan?); OCR comes in M9.")
    return text


def _docx_text(data: bytes) -> str:
    document = open_docx(BytesIO(data))
    blocks: list[str] = []
    # iter_inner_content keeps paragraphs and tables in document order.
    for item in document.iter_inner_content():
        if isinstance(item, Table):
            blocks.append(_markdown_table(item))
        else:
            line = _paragraph_line(item)
            if line:
                blocks.append(line)
    return "\n\n".join(blocks)


def _paragraph_line(paragraph: Paragraph) -> str:
    text = paragraph.text.strip()
    if not text:
        return ""
    style = (paragraph.style.name if paragraph.style is not None else "") or ""
    if style == "Title":
        return f"# {text}"
    if style.startswith("Heading "):
        level = style.removeprefix("Heading ").strip()
        depth = int(level) + 1 if level.isdigit() else 2  # Title is #, Heading 1 is ##
        return f"{'#' * min(depth, 6)} {text}"
    if style.startswith("List"):
        return f"- {text}"
    return text


def _markdown_table(table: Table) -> str:
    rows = [[cell.text.strip().replace("|", "/") for cell in row.cells] for row in table.rows]
    if not rows:
        return ""
    header, *body = rows
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)
