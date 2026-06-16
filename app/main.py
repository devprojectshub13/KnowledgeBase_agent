from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import APIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import answer_question
from app.config import settings
from app.db import get_session, init_db
from app.extract import extract_invoice
from app.parsing import is_supported, parse_to_markdown
from app.schemas import (
    AskRequest,
    AskResponse,
    IngestResponse,
    MessageOut,
    SessionResponse,
    SessionSummary,
)
from app.sessions import (
    append_turn,
    create_session,
    delete_session,
    list_sessions,
    load_history,
    load_transcript,
    session_exists,
)
from app.store import (
    delete_invoice,
    find_existing,
    list_invoices,
    read_invoice,
    save_invoice,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="invoice-agent", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request: Request, call_next):
    """Stop the browser caching SPA assets, so edits show up on refresh."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.exception_handler(APIError)
async def llm_error_handler(request: Request, exc: APIError) -> JSONResponse:
    """Surface LLM/provider errors as JSON so the frontend never sees a raw 500."""
    return JSONResponse(
        status_code=503,
        content={"detail": "The language model request failed. Please try again."},
    )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(
    file: UploadFile = File(...),
    on_duplicate: str = Form("ask"),  # ask | replace | keep_both
) -> IngestResponse:
    """Upload one invoice (PDF/image/DOCX/XLSX/…) → MarkItDown → LLM extraction →
    stored as a structured markdown invoice.

    If an invoice with the same number AND seller already exists, we do NOT
    silently overwrite or duplicate: with on_duplicate="ask" (default) we return
    409 with the existing invoice's details so the user can choose to replace it
    or keep both. on_duplicate="replace" overwrites; "keep_both" stores a copy.
    """
    filename = file.filename or "invoice"
    if not is_supported(filename):
        raise HTTPException(status_code=415, detail=f"Unsupported file: {filename}")
    data = await file.read()
    markdown = await run_in_threadpool(parse_to_markdown, filename, data)
    if not markdown:
        raise HTTPException(status_code=422, detail="No extractable text in file")

    fields, body = await extract_invoice(filename, markdown)
    existing = find_existing(fields.get("invoice_no"), fields.get("seller_name"))

    if existing and on_duplicate == "ask":
        raise HTTPException(
            status_code=409,
            detail={
                "message": "An invoice with the same number and seller already exists.",
                "existing_name": existing,
                "invoice_no": fields.get("invoice_no"),
                "seller_name": fields.get("seller_name"),
                "total_amount": fields.get("total_amount"),
            },
        )

    name = save_invoice(
        fields, body, name=existing if on_duplicate == "replace" else None
    )
    return IngestResponse(
        name=name,
        invoice_no=fields.get("invoice_no"),
        total_amount=fields.get("total_amount"),
        tax_amount=fields.get("tax_amount"),
        currency=fields.get("currency"),
    )


@app.get("/invoices")
async def invoices_list() -> list[dict]:
    """Structured rows for every stored invoice."""
    return list_invoices()


@app.get("/invoices/{name}")
async def invoice_detail(name: str) -> dict:
    content = read_invoice(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {"name": name, "content": content}


@app.delete("/invoices/{name}", status_code=204)
async def invoice_delete(name: str) -> None:
    if not delete_invoice(name):
        raise HTTPException(status_code=404, detail="Invoice not found")


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
    return [MessageOut(**m) for m in await load_transcript(session, session_id)]


@app.post("/ask", response_model=AskResponse)
async def ask(
    req: AskRequest,
    session: AsyncSession = Depends(get_session),
) -> AskResponse:
    if req.session_id:
        if not await session_exists(session, req.session_id):
            raise HTTPException(status_code=404, detail="Unknown session")
        session_id = req.session_id
    else:
        session_id = await create_session(session)

    history = await load_history(session, session_id)
    result = await answer_question(req.question, history=history)
    meta = {
        "chart": result.chart.model_dump() if result.chart else None,
        "sources": result.sources,
        "aggregated": result.aggregated,
    }
    await append_turn(session, session_id, req.question, result.answer, meta=meta)
    result.session_id = session_id
    return result


# ---------- Frontend (served last so API routes take precedence) ----------
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")
