# syntax=docker/dockerfile:1

FROM python:3.12-slim

# uv installs/resolves dependencies; settings keep the image lean and the venv
# on PATH so we can call uvicorn directly.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

# uv binary (fast, reproducible installs).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install dependencies first (cached unless pyproject/lock change).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Application code.
COPY app ./app
COPY web ./web

# Where extracted invoices are written (mount a volume to persist them).
RUN mkdir -p /app/invoice_data

EXPOSE 9001

# DATABASE_URL, LLM_API_KEY, LLM_MODEL are provided at runtime (env / compose).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9001"]
