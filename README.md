# agent-vector

Semantic ingestion + a conversational retrieval agent over a vector database.

- **File parsing:** Microsoft **MarkItDown** (PDF, DOCX, PPTX, XLSX, HTML, CSV → Markdown)
- **Chunking:** **semantic** — the LLM returns boundary *anchors*, text is split locally (line-aware fallback)
- **Embeddings:** OpenAI `text-embedding-3-small` (1536-dim, $0.02 / 1M tokens)
- **LLM / agent:** OpenAI (default `gpt-4o-mini`) — tool-calling + JSON
- **Vector store:** Postgres + `pgvector` (HNSW, cosine)
- **Sessions:** multi-turn chat history persisted per `session_id`
- **Chat attachments:** attach a file to one conversation — parsed inline as `<file>…</file>` context (MarkItDown), saved & downloadable, **never** added to the KB
- **API:** FastAPI
- **UI:** monochrome single-page frontend served at `/` (no build step)

Pipeline: **upload → MarkItDown → semantic chunk (OpenAI) → embed (OpenAI) → pgvector**.
The agent answers questions by calling a `search_knowledge_base` tool that runs cosine
similarity search over the chunks, grounding its answer on the hits, with conversation memory.

## Semantic chunking (anchor method)

The LLM does **not** echo the document back as JSON (that breaks on code/file-trees
with backslashes, pipes, quotes). Instead it returns only short verbatim *anchor*
snippets marking where each new section begins, and the original text is split locally
at those points — preserving text exactly and never cutting mid-line. If a call fails,
it falls back to a line-aware structural splitter (still no mid-line cuts).

## Two OpenAI keys

The chat agent + chunker and the embeddings use **separate OpenAI keys**
(`LLM_API_KEY` for chat/chunking, `OPENAI_API_KEY` for embeddings) so usage and
rate limits can be tracked independently.

## Ports (9k series for this project)

- Postgres → **9432** (host) → 5432 (container)
- API → **9000**

## Setup

```bash
uv sync
cp .env.example .env          # then fill in LLM_API_KEY and OPENAI_API_KEY
docker compose up -d          # starts pgvector on 9432
uv run uvicorn app.main:app --port 9000
```

## Endpoints

| Method | Path                          | Purpose                                              |
|--------|-------------------------------|------------------------------------------------------|
| GET    | `/health`                     | Liveness                                             |
| POST   | `/ingest`                     | `{document, content}` → semantic chunk, embed, store |
| POST   | `/ingest/file`                | upload PDF/DOCX/… → MarkItDown → ingest              |
| GET    | `/documents`                  | list ingested documents (name, chunk count, size)   |
| GET    | `/documents/{name}/download`  | download original file (or reconstructed Markdown)  |
| DELETE | `/documents/{name}`           | delete a document, its chunks, and its file         |
| GET    | `/search`                     | `?q=...` → raw similarity hits (no LLM)              |
| GET    | `/sessions`                   | list conversations (title, count, last active)      |
| POST   | `/sessions`                   | create a conversation → `{session_id}`              |
| DELETE | `/sessions/{id}`              | delete a conversation and its messages              |
| GET    | `/sessions/{id}/messages`     | conversation history                                |
| POST   | `/ask`                        | multipart: `question`, `session_id?`, optional `file` → grounded answer |
| GET    | `/attachments/{id}/download`  | download a chat-attached file (session-only)        |

### Examples

```bash
# Ingest raw text
curl -X POST localhost:9000/ingest -H 'Content-Type: application/json' \
  -d '{"document":"handbook","content":"Refunds are processed within 5 business days."}'

# Ingest a file (PDF/DOCX/PPTX/XLSX/HTML/CSV)
curl -X POST localhost:9000/ingest/file \
  -F 'file=@./manual.pdf' -F 'document=manual'

curl "localhost:9000/search?q=refund%20time"

# Ask (omit session_id to start a new conversation; the response returns one)
curl -X POST localhost:9000/ask -H 'Content-Type: application/json' \
  -d '{"question":"How long do refunds take?"}'

# Continue the same conversation
curl -X POST localhost:9000/ask -H 'Content-Type: application/json' \
  -d '{"question":"And for international orders?","session_id":"<id-from-previous>"}'
```

Re-ingesting the same `document` name replaces its previous chunks (idempotent).

## Layout

```
app/
  config.py      settings (pydantic-settings, reads .env)
  db.py          async engine; Chunk + ChatSession + Message models; pgvector/HNSW
  llm.py         shared OpenAI client + retry wrapper (chunking + agent)
  parsing.py     MarkItDown: file bytes → Markdown
  chunking.py    semantic chunking via anchors (line-aware fallback)
  embeddings.py  OpenAI embedding client
  ingest.py      chunk → embed → store
  retrieval.py   cosine similarity search
  sessions.py    create/load/append conversation turns
  agent.py       OpenAI LLM + search_knowledge_base tool loop
  main.py        FastAPI routes + static frontend mount
web/
  index.html     single-page UI (ingest + chat)
  styles.css     monochrome design system
  app.js         vanilla JS — fetch, sessions (localStorage), rendering
```

Open **http://localhost:9000/** in a browser for the UI.
