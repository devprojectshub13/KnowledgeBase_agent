from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Chunk
from app.embeddings import embed_query
from app.schemas import SearchHit


async def search(session: AsyncSession, query: str, top_k: int) -> list[SearchHit]:
    """Cosine-similarity search over stored chunks."""
    query_vec = await embed_query(query)

    # cosine_distance is in [0, 2]; similarity = 1 - distance.
    distance = Chunk.embedding.cosine_distance(query_vec).label("distance")
    stmt = select(Chunk, distance).order_by(distance).limit(top_k)
    rows = (await session.execute(stmt)).all()

    return [
        SearchHit(
            document=chunk.document,
            chunk_index=chunk.chunk_index,
            content=chunk.content,
            score=round(1.0 - dist, 4),
        )
        for chunk, dist in rows
    ]
