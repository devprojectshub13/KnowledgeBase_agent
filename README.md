# invoice-agent

Invoice analytics agent — upload invoices, ask questions, get exact totals and charts.

This is a sibling of the semantic-RAG app (`main` branch). RAG is the wrong tool
for **aggregation** ("total of 100 invoices", "state-wise sales") — vector search
only returns the top-k *similar* chunks, so the model never sees every invoice.
Here we extract each invoice to **structured markdown** and compute over all of
them deterministically.

## How it works

```
upload → MarkItDown → LLM extraction → invoice_data/<no>.md (YAML frontmatter + body)
ask    → agent → aggregate_invoices (exact, in code) → answer (+ rendered chart)
```

- **Extraction (write):** each invoice is parsed and the LLM pulls structured
  fields (invoice no, date, seller/buyer, state, currency, total, tax) into a
  markdown file's YAML frontmatter.
- **Query agent (read):** answers only from the stored invoices via tools:
  - `aggregate_invoices(metric, group_by)` — **exact** totals/counts/breakdowns,
    computed in Python (the LLM never does the arithmetic).
  - `list_invoices` / `read_invoice(name)` — inspect or drill into invoices.
  - `render_chart(type, title, labels, values)` — draws a pie/line/bar in the UI.
- **Frontend:** monochrome single-page UI with Chart.js for rendered charts.

The key design rule: **numbers come from code, prose comes from the LLM.** That's
what makes "total tax of all invoices" correct instead of a best guess.

## Sample questions

- Give total tax amount from all invoices
- State wise sales pie chart
- Company growth line chart by month by sales

## Ports

- Postgres → **9432** (sessions/messages only — no pgvector here)
- API → **9001**

## Setup (local)

```bash
uv sync
cp .env.example .env          # fill in LLM_API_KEY
docker compose up -d db       # Postgres on 9432
uv run uvicorn app.main:app --port 9001
```

## Run with Docker

Full stack (Postgres + app) via compose — fill in `.env` first:

```bash
cp .env.example .env          # LLM_API_KEY (DATABASE_URL is set by compose)
docker compose up --build     # app on http://localhost:9001
```

Or run the published image against your own Postgres:

```bash
docker run -p 9001:9001 \
  -e LLM_API_KEY=sk-... \
  -e DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/agentvector \
  -v "$PWD/invoice_data:/app/invoice_data" \
  bhutiyalakhan/invoice-agent:latest
```

Image: **`bhutiyalakhan/invoice-agent`** on Docker Hub (`:latest`, `:0.1.0`).

Open **http://localhost:9001/**.

## Endpoints

| Method | Path                        | Purpose                                   |
|--------|-----------------------------|-------------------------------------------|
| POST   | `/ingest/file`              | upload an invoice → extract → store        |
| GET    | `/invoices`                 | structured rows for every invoice          |
| GET    | `/invoices/{name}`          | full detail of one invoice                 |
| DELETE | `/invoices/{name}`          | delete a stored invoice                    |
| POST   | `/ask`                      | `{question, session_id?}` → answer + chart |
| GET/POST/DELETE | `/sessions...`     | conversation sessions                      |

## Layout

```
app/
  config.py    settings
  db.py        sessions + messages (Postgres)
  parsing.py   MarkItDown: file bytes → markdown
  extract.py   invoice extraction (the "write" side)
  store.py     markdown invoice store + exact aggregate()
  agent.py     query agent: aggregate / list / read / render_chart tools
  sessions.py  conversation turns
  main.py      FastAPI routes + static frontend
web/
  index.html, styles.css, js/app.js, js/chart.umd.min.js (+ marked, purify)
```
