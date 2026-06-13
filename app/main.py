from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from openai import APIError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import answer_question
from app.attachments import build_file_block, get_attachment, save_attachment
from app.config import settings
from app.db import Chunk, get_session, init_db
from app.documents import (
    STORAGE,
    delete_document,
    get_file,
    list_documents,
    store_file,
)
from app.ingest import ingest_document
from app.parsing import is_supported, parse_to_markdown
from app.retrieval import search
from app.schemas import (
    AskResponse,
    AttachmentOut,
    DocumentSummary,
    IngestRequest,
    IngestResponse,
    MessageOut,
    SearchHit,
    SessionResponse,
    SessionSummary,
)
from app.sessions import (
    append_turn,
    create_session,
    delete_session,
    list_sessions,
    load_history,
    session_exists,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="agent-vector", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request: Request, call_next):
    """Stop the browser caching the SPA assets, so edits show up on refresh."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.exception_handler(APIError)
async def llm_error_handler(request: Request, exc: APIError) -> JSONResponse:
    """Return provider/LLM errors as JSON so the frontend never sees a raw
    500 body (which would break JSON.parse)."""
    status = getattr(exc, "status_code", None) or 502
    msg = str(exc).lower()
    if status in (413, 429) or "rate_limit" in msg or "too large" in msg:
        detail = (
            "The model request was too large or rate-limited (free-tier token "
            "limit). Try a shorter question, fewer documents, or start a new chat."
        )
    else:
        detail = "The language model request failed. Please try again."
    return JSONResponse(status_code=503, content={"detail": detail})


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse)
async def ingest(
    req: IngestRequest,
    session: AsyncSession = Depends(get_session),
) -> IngestResponse:
    n = await ingest_document(session, req.document, req.content)
    # Keep the raw text downloadable as a .md file.
    await store_file(
        session,
        req.document,
        f"{req.document}.md",
        "text/markdown",
        req.content.encode("utf-8"),
    )
    return IngestResponse(document=req.document, chunks_ingested=n)


@app.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(
    file: UploadFile = File(...),
    document: str | None = Form(None),
    session: AsyncSession = Depends(get_session),
) -> IngestResponse:
    """Upload a PDF/DOCX/PPTX/XLSX/etc. — parsed to Markdown via MarkItDown,
    then semantically chunked, embedded and stored."""
    if not is_supported(file.filename or ""):
        raise HTTPException(
            status_code=415, detail=f"Unsupported file type: {file.filename}"
        )
    data = await file.read()
    # MarkItDown is synchronous/CPU-bound — offload so the event loop stays free.
    markdown = await run_in_threadpool(
        parse_to_markdown, file.filename or "upload", data
    )
    if not markdown:
        raise HTTPException(status_code=422, detail="No extractable text in file")

    name = document or (file.filename or "upload")
    n = await ingest_document(session, name, markdown)
    # Persist the ORIGINAL uploaded file so it can be downloaded later.
    await store_file(
        session,
        name,
        file.filename or f"{name}",
        file.content_type or "application/octet-stream",
        data,
    )
    return IngestResponse(document=name, chunks_ingested=n)


@app.get("/documents", response_model=list[DocumentSummary])
async def documents_list(
    session: AsyncSession = Depends(get_session),
) -> list[DocumentSummary]:
    return [DocumentSummary(**d) for d in await list_documents(session)]


@app.get("/documents/{name:path}/download")
async def download_document(
    name: str,
    session: AsyncSession = Depends(get_session),
):
    """Download a document. Returns the original uploaded file if stored,
    otherwise reconstructs the parsed Markdown from its chunks (for documents
    ingested before file storage existed)."""
    doc = await get_file(session, name)
    if doc:
        path = STORAGE / doc.stored_path
        if path.exists():
            return FileResponse(
                path,
                media_type=doc.content_type or "application/octet-stream",
                filename=doc.filename,
            )

    # Fallback: rebuild Markdown from stored chunks.
    chunks = (
        await session.execute(
            select(Chunk.content)
            .where(Chunk.document == name)
            .order_by(Chunk.chunk_index)
        )
    ).scalars().all()
    if not chunks:
        raise HTTPException(status_code=404, detail="Document not found")
    body = "\n\n".join(chunks).encode("utf-8")
    return Response(
        content=body,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{name}.md"'},
    )


@app.delete("/documents/{name:path}", status_code=204)
async def remove_document(
    name: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await delete_document(session, name):
        raise HTTPException(status_code=404, detail="Unknown document")


@app.get("/search", response_model=list[SearchHit])
async def search_endpoint(
    q: str,
    session: AsyncSession = Depends(get_session),
) -> list[SearchHit]:
    return await search(session, q, settings.top_k)


@app.get("/attachments/{att_id}/download")
async def download_attachment(
    att_id: str,
    session: AsyncSession = Depends(get_session),
):
    att = await get_attachment(session, att_id)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = STORAGE / att.stored_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return FileResponse(
        path,
        media_type=att.content_type or "application/octet-stream",
        filename=att.filename,
    )


@app.get("/sessions", response_model=list[SessionSummary])
async def sessions_list(
    session: AsyncSession = Depends(get_session),
) -> list[SessionSummary]:
    return [SessionSummary(**s) for s in await list_sessions(session)]


@app.post("/sessions", response_model=SessionResponse)
async def new_session(
    session: AsyncSession = Depends(get_session),
) -> SessionResponse:
    return SessionResponse(session_id=await create_session(session))


@app.delete("/sessions/{session_id}", status_code=204)
async def remove_session(
    session_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await delete_session(session, session_id):
        raise HTTPException(status_code=404, detail="Unknown session")


@app.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
async def session_messages(
    session_id: str,
    session: AsyncSession = Depends(get_session),
) -> list[MessageOut]:
    if not await session_exists(session, session_id):
        raise HTTPException(status_code=404, detail="Unknown session")
    history = await load_history(session, session_id)
    return [MessageOut(**m) for m in history]


@app.post("/ask", response_model=AskResponse)
async def ask(
    question: str = Form(...),
    session_id: str | None = Form(None),
    file: UploadFile | None = File(None),
    session: AsyncSession = Depends(get_session),
) -> AskResponse:
    # Resolve or create the conversation session.
    if session_id:
        if not await session_exists(session, session_id):
            raise HTTPException(status_code=404, detail="Unknown session")
    else:
        session_id = await create_session(session)

    # Optional attachment: parsed and inlined as context for THIS conversation
    # only (never ingested into the knowledge base).
    file_block: str | None = None
    attachment_out: AttachmentOut | None = None
    stored_question = question
    if file is not None and file.filename:
        if not is_supported(file.filename):
            raise HTTPException(
                status_code=415, detail=f"Unsupported file type: {file.filename}"
            )
        data = await file.read()
        text = await run_in_threadpool(parse_to_markdown, file.filename, data)
        if not text:
            raise HTTPException(status_code=422, detail="No extractable text in file")
        ctype = file.content_type or "application/octet-stream"
        att = await save_attachment(session, session_id, file.filename, ctype, data)
        file_block = build_file_block(file.filename, ctype, att.size, text)
        attachment_out = AttachmentOut(
            id=att.id, filename=att.filename, size=att.size
        )
        # Keep history compact: store a marker, not the full file content.
        stored_question = f"\U0001f4ce {file.filename}\n{question}"

    history = await load_history(session, session_id)
    result = await answer_question(
        session, question, history=history, file_block=file_block
    )
    await append_turn(session, session_id, stored_question, result.answer)
    result.session_id = session_id
    result.attachment = attachment_out
    return result


# ---------- Frontend (served last so API routes take precedence) ----------
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")
