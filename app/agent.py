import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.llm import chat_completion
from app.retrieval import search
from app.schemas import AskResponse, SearchHit

SYSTEM_PROMPT = (
    "You are a retrieval assistant that answers ONLY from a private knowledge "
    "base (KB) of ingested documents.\n"
    "\n"
    "Searching:\n"
    "- For any question about information or content, call the "
    "`search_knowledge_base` tool.\n"
    "- If the returned chunks are NOT relevant to the user's question, call the "
    "tool AGAIN with a reworded query — try different keywords, synonyms, or a "
    "broader/narrower phrasing. You may search at most 3 times.\n"
    "- Do NOT search for greetings, small talk, or follow-ups already answered in "
    "the conversation — reply to those directly.\n"
    "\n"
    "Answering (strict):\n"
    "- Base every factual answer ONLY on the retrieved KB chunks OR on a file the "
    "user attached to this conversation. NEVER use outside or general knowledge, "
    "and never guess or invent.\n"
    "- When the user attaches a file, that file is trusted context you may use to "
    "answer directly — you do NOT need to search the knowledge base for questions "
    "about the attached file.\n"
    "- ALWAYS end every factual answer with a citation on its own line, formatted "
    'exactly as "(Source: <name>)". Use the document name(s) for KB answers, or '
    "the exact attached file name for answers from an attached file. This is "
    "mandatory — never omit it, including when answering from an attached file.\n"
    "- If neither the KB nor any attached file contains the requested information, "
    "do NOT answer. Say the information isn't available and suggest they rephrase, "
    "attach a file, or ingest a relevant document. Do not fall back to your own "
    "knowledge."
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": "Semantic search over the ingested documents. Returns the most relevant text chunks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural-language search query.",
                    }
                },
                "required": ["query"],
            },
        },
    }
]

# The agent may run the search at most this many times (reformulating the query
# on a miss). Tools stay available on every call, and the cap is enforced in
# code by returning a "stop searching" result once the limit is reached.
MAX_SEARCHES = 3
_HARD_CAP_ROUNDS = MAX_SEARCHES + 3  # absolute ceiling on LLM round-trips

_STOP_SEARCHING = json.dumps(
    {
        "note": (
            "Search limit reached. Do NOT call this tool again. Using only the "
            "results already returned above, answer the user's question now, or — "
            "if nothing relevant was found — tell the user the knowledge base does "
            "not contain information on that topic."
        )
    }
)


async def answer_question(
    session: AsyncSession,
    question: str,
    history: list[dict] | None = None,
    file_block: str | None = None,
) -> AskResponse:
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    # A chat-attached file is inlined as context for THIS turn only. It is not
    # part of the knowledge base; the user may ask about it directly.
    if file_block:
        user_content = (
            f"The user attached a file. Use it to answer if relevant "
            f"(this is not from the knowledge base):\n{file_block}\n\n{question}"
        )
    else:
        user_content = question
    messages.append({"role": "user", "content": user_content})
    collected: dict[tuple[str, int], SearchHit] = {}
    searches_done = 0

    for _ in range(_HARD_CAP_ROUNDS):
        # Tools are ALWAYS offered; the search cap is enforced via the tool
        # result instead of by withholding tools mid-conversation.
        completion = await chat_completion(
            model=settings.llm_model,
            messages=messages,
            tools=TOOLS,
            temperature=0.2,
        )
        msg = completion.choices[0].message

        if not msg.tool_calls:
            return AskResponse(
                answer=msg.content or "",
                sources=list(collected.values()),
            )

        messages.append(msg.model_dump(exclude_none=True))

        for call in msg.tool_calls:
            if searches_done >= MAX_SEARCHES:
                # Out of search budget — push the model to answer or decline.
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": _STOP_SEARCHING,
                    }
                )
                continue

            args = json.loads(call.function.arguments or "{}")
            hits = await search(session, args.get("query", question), settings.top_k)
            searches_done += 1
            for h in hits:
                collected[(h.document, h.chunk_index)] = h
            # Trim per-chunk content sent to the model to stay within the LLM's
            # token budget. Full content is kept for the displayed sources via
            # `collected`.
            tool_payload = [
                {
                    "document": h.document,
                    "chunk_index": h.chunk_index,
                    "content": h.content[: settings.context_char_limit],
                }
                for h in hits
            ]
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(tool_payload),
                }
            )

    # Exhausted the round ceiling without a plain answer — decline safely.
    return AskResponse(
        answer=(
            "I couldn't find information on that topic in the knowledge base. "
            "Try rephrasing your question or ingest a relevant document."
        ),
        sources=list(collected.values()),
    )
