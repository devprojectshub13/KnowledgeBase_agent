from openai import AsyncOpenAI

from app.config import settings

# Dedicated OpenAI client for embeddings (separate key from the chat agent).
_client = AsyncOpenAI(api_key=settings.openai_api_key)


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts with text-embedding-3-small."""
    if not texts:
        return []
    resp = await _client.embeddings.create(model=settings.embedding_model, input=texts)
    return [item.embedding for item in resp.data]


async def embed_query(text: str) -> list[float]:
    return (await embed_texts([text]))[0]
