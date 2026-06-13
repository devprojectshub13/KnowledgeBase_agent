import uuid
from pathlib import Path

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import Chunk, Document

STORAGE = Path(settings.storage_dir).resolve()


async def persist_blob(data: bytes, filename: str, prefix: str = "") -> str:
    """Write bytes to the storage dir under a unique name (keeping the original
    extension) and return that relative name. The disk write is offloaded so the
    event loop stays free for large files. Shared by KB documents and chat
    attachments."""
    STORAGE.mkdir(parents=True, exist_ok=True)
    stored = f"{prefix}{uuid.uuid4().hex}{Path(filename).suffix}"
    await run_in_threadpool((STORAGE / stored).write_bytes, data)
    return stored


async def list_documents(session: AsyncSession) -> list[dict]:
    """All ingested documents with chunk counts and (if available) file size."""
    chunk_rows = (
        await session.execute(
            select(Chunk.document, func.count(Chunk.id))
            .group_by(Chunk.document)
            .order_by(Chunk.document)
        )
    ).all()
    files = {
        row.name: row
        for row in (
            await session.execute(
                select(Document.name, Document.filename, Document.size)
            )
        ).all()
    }
    out: list[dict] = []
    for name, n in chunk_rows:
        f = files.get(name)
        out.append(
            {
                "document": name,
                "chunks": n,
                "filename": f.filename if f else None,
                "size": f.size if f else None,
            }
        )
    return out


async def store_file(
    session: AsyncSession,
    name: str,
    filename: str,
    content_type: str,
    data: bytes,
) -> None:
    """Persist the original file bytes to disk and upsert its metadata row.
    Replacing a document overwrites the previous file."""
    stored = await persist_blob(data, filename)

    existing = await session.get(Document, name)
    if existing:
        old = STORAGE / existing.stored_path
        await run_in_threadpool(lambda: old.unlink(missing_ok=True))
        existing.filename = filename
        existing.content_type = content_type
        existing.size = len(data)
        existing.stored_path = stored
    else:
        session.add(
            Document(
                name=name,
                filename=filename,
                content_type=content_type,
                size=len(data),
                stored_path=stored,
            )
        )
    await session.commit()


async def get_file(session: AsyncSession, name: str) -> Document | None:
    return await session.get(Document, name)


async def delete_document(session: AsyncSession, name: str) -> bool:
    """Delete a document's chunks, its metadata, and its file on disk."""
    res = await session.execute(delete(Chunk).where(Chunk.document == name))
    doc = await session.get(Document, name)
    if doc:
        path = STORAGE / doc.stored_path
        await run_in_threadpool(lambda: path.unlink(missing_ok=True))
        await session.delete(doc)
    await session.commit()
    return res.rowcount > 0 or doc is not None
