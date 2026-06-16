from typing import Literal

from pydantic import BaseModel


class IngestResponse(BaseModel):
    name: str
    invoice_no: str | None = None
    total_amount: float | None = None
    tax_amount: float | None = None
    currency: str | None = None


class AskRequest(BaseModel):
    question: str
    session_id: str | None = None


class ChartSpec(BaseModel):
    type: Literal["pie", "line", "bar"]
    title: str
    labels: list[str]
    values: list[float]


class AskResponse(BaseModel):
    answer: str
    chart: ChartSpec | None = None
    sources: list[str] = []  # invoice names the agent read for this answer
    session_id: str | None = None


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
