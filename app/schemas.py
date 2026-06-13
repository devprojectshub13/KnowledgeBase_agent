from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    document: str = Field(..., description="Logical name/source of the document")
    content: str = Field(..., min_length=1)


class IngestResponse(BaseModel):
    document: str
    chunks_ingested: int


class DocumentSummary(BaseModel):
    document: str
    chunks: int
    filename: str | None = None
    size: int | None = None


class SearchHit(BaseModel):
    document: str
    chunk_index: int
    content: str
    score: float


class AttachmentOut(BaseModel):
    id: str
    filename: str
    size: int


class AskResponse(BaseModel):
    answer: str
    sources: list[SearchHit]
    session_id: str | None = None
    attachment: AttachmentOut | None = None


class SessionResponse(BaseModel):
    session_id: str


class SessionSummary(BaseModel):
    session_id: str
    title: str
    message_count: int
    last_active: str | None = None


class MessageOut(BaseModel):
    role: str
    content: str
