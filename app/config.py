from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM (OpenAI) — used for the chat agent and semantic chunking.
    # Uses its own key, separate from the embeddings key below.
    llm_api_key: str = Field(validation_alias="LLM_API_KEY")
    llm_model: str = "gpt-4o-mini"

    # LLM call resilience
    llm_max_retries: int = 5
    llm_max_retry_wait: float = 35.0

    # Semantic chunking
    semantic_chunk_max_tokens: int = 4000  # window size fed to the LLM per call
    chunk_target_tokens: int = 350  # rough size the LLM aims for per chunk

    # Embeddings (OpenAI)
    openai_api_key: str
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agentvector"

    # Where original uploaded files are stored on disk (for download)
    storage_dir: str = "storage"

    # Max characters of a chat-attached file inlined into the prompt (the rest
    # is truncated with a notice, to stay within the LLM token budget). These
    # attachments are session-only context — never ingested into the KB.
    attachment_char_limit: int = 12000

    # Retrieval
    top_k: int = 5
    context_char_limit: int = 900  # max chars per chunk sent to the LLM

    # Conversation sessions
    history_turns: int = 6  # how many prior user/assistant turns to replay


settings = Settings()
