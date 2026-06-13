from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.chunking import semantic_chunk
from app.db import Chunk
from app.embeddings import embed_texts


async def ingest_document(session: AsyncSession, document: str, content: str) -> int:
    """Semantically chunk, embed and store a document. Re-ingesting replaces
    prior chunks."""
    # Idempotent per document name: clear previous chunks first.
    await session.execute(delete(Chunk).where(Chunk.document == document))

    chunks = await semantic_chunk(content)
    if not chunks:
        await session.commit()
        return 0

    vectors = await embed_texts(chunks)
    session.add_all(
        [
            Chunk(
                document=document,
                chunk_index=i,
                content=text,
                embedding=vector,
            )
            for i, (text, vector) in enumerate(zip(chunks, vectors, strict=True))
        ]
    )
    await session.commit()
    return len(chunks)
