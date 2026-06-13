import tempfile
from pathlib import Path

from markitdown import MarkItDown

# MarkItDown converts PDF/DOCX/PPTX/XLSX/HTML/etc. into Markdown, which then
# flows into the semantic chunker. One instance is reusable and stateless.
_md = MarkItDown()

# Extensions we accept for upload-based ingestion.
SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".doc",
    ".pptx",
    ".ppt",
    ".xlsx",
    ".xls",
    ".html",
    ".htm",
    ".md",
    ".txt",
    ".csv",
    ".json",
}


def is_supported(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS


def parse_to_markdown(filename: str, data: bytes) -> str:
    """Convert an uploaded file's bytes to Markdown text via MarkItDown.

    Writes to a temp file with the original extension so MarkItDown can
    dispatch to the right converter.
    """
    ext = Path(filename).suffix.lower() or ".bin"
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        result = _md.convert(str(tmp_path))
        return (result.text_content or "").strip()
    finally:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)
