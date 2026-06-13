from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import ChatSession, Message


async def list_sessions(session: AsyncSession) -> list[dict]:
    """All sessions that have at least one message, newest activity first,
    each with a title (first user message) and message count."""
    # Per-session aggregates: message count and most-recent message time.
    agg = (
        select(
            Message.session_id.label("sid"),
            func.count(Message.id).label("n"),
            func.max(Message.created_at).label("last"),
        )
        .group_by(Message.session_id)
        .subquery()
    )
    rows = (
        await session.execute(
            select(agg.c.sid, agg.c.n, agg.c.last).order_by(agg.c.last.desc())
        )
    ).all()

    summaries: list[dict] = []
    for sid, n, last in rows:
        title = await session.scalar(
            select(Message.content)
            .where(Message.session_id == sid, Message.role == "user")
            .order_by(Message.id.asc())
            .limit(1)
        )
        summaries.append(
            {
                "session_id": sid,
                "title": (title or "New conversation").strip(),
                "message_count": n,
                "last_active": last.isoformat() if last else None,
            }
        )
    return summaries


async def create_session(session: AsyncSession) -> str:
    chat = ChatSession()
    session.add(chat)
    await session.commit()
    return chat.id


async def delete_session(session: AsyncSession, session_id: str) -> bool:
    """Delete a session and its messages. Returns False if it didn't exist."""
    existed = await session_exists(session, session_id)
    if existed:
        await session.execute(
            delete(Message).where(Message.session_id == session_id)
        )
        await session.execute(
            delete(ChatSession).where(ChatSession.id == session_id)
        )
        await session.commit()
    return existed


async def session_exists(session: AsyncSession, session_id: str) -> bool:
    return (
        await session.scalar(
            select(ChatSession.id).where(ChatSession.id == session_id)
        )
    ) is not None


async def load_history(session: AsyncSession, session_id: str) -> list[dict]:
    """Return prior turns as chat messages, oldest first, capped to the most
    recent N turns to keep the prompt bounded."""
    stmt = (
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(settings.history_turns * 2)
    )
    rows = list((await session.execute(stmt)).scalars())
    rows.reverse()
    return [{"role": m.role, "content": m.content} for m in rows]


async def append_turn(
    session: AsyncSession,
    session_id: str,
    question: str,
    answer: str,
) -> None:
    session.add_all(
        [
            Message(session_id=session_id, role="user", content=question),
            Message(session_id=session_id, role="assistant", content=answer),
        ]
    )
    await session.commit()
