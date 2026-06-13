import asyncio

from openai import AsyncOpenAI, RateLimitError

from app.config import settings

# Shared OpenAI client for the semantic chunker and chat/retrieval agent.
# Uses the dedicated LLM key (separate from the embeddings key).
llm = AsyncOpenAI(api_key=settings.llm_api_key)


def _retry_after(err: RateLimitError, default: float) -> float:
    """Best-effort extraction of the provider's Retry-After hint."""
    try:
        return float(err.response.headers.get("retry-after", default))
    except Exception:
        return default


async def chat_completion(**kwargs):
    """Wrapper around chat.completions.create that retries on 429s."""
    delay = 2.0
    last_err: RateLimitError | None = None
    for _ in range(settings.llm_max_retries):
        try:
            return await llm.chat.completions.create(**kwargs)
        except RateLimitError as err:
            last_err = err
            wait = min(_retry_after(err, delay), settings.llm_max_retry_wait)
            await asyncio.sleep(wait)
            delay *= 2
    assert last_err is not None
    raise last_err
