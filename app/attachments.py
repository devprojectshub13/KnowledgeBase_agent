from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import Attachment
from app.documents import persist_blob


async def save_attachment(
    session: AsyncSession,
    session_id: str,
    filename: str,
    content_type: str,
    data: bytes,
) -> Attachment:
    """Persist a chat attachment's bytes to disk and record its metadata,
    scoped to one conversation. Not part of the knowledge base."""
    stored = await persist_blob(data, filename, prefix="att_")

    att = Attachment(
        session_id=session_id,
        filename=filename,
        content_type=content_type,
        size=len(data),
        stored_path=stored,
    )
    session.add(att)
    await session.commit()
    await session.refresh(att)
    return att


async def get_attachment(session: AsyncSession, att_id: str) -> Attachment | None:
    return await session.get(Attachment, att_id)


def build_file_block(filename: str, content_type: str, size: int, text: str) -> str:
    """Wrap parsed file content for the prompt, with metadata, truncating to the
    inline character budget so it never blows the LLM token limit."""
    limit = settings.attachment_char_limit
    truncated = len(text) > limit
    body = text[:limit] + ("\n…[truncated]" if truncated else "")
    return (
        f'<file name="{filename}" type="{content_type}" '
        f'size="{size}" bytes truncated="{str(truncated).lower()}">\n'
        f"{body}\n</file>"
    )
