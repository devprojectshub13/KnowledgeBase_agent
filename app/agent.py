import json

from app.config import settings
from app.llm import chat_completion
from app.schemas import AskResponse, ChartSpec
from app.store import aggregate, list_invoices, read_invoice

SYSTEM_PROMPT = (
    "You are an invoice analytics assistant. You answer ONLY from the stored "
    "invoices, accessed through your tools — never from outside knowledge, and "
    "never invent numbers.\n"
    "\n"
    "Tools:\n"
    "- `aggregate_invoices(metric, group_by)`: the ONLY correct way to get "
    "totals, counts, and breakdowns — it computes exact numbers for you. "
    "metric is total_amount | tax_amount | count. group_by is omitted for a "
    "grand total, or one of buyer_state, seller_state, currency, month. "
    'For "sales by state" use metric=total_amount, group_by=buyer_state (the '
    'place of supply). For "monthly growth" use group_by=month.\n'
    "- `render_chart(chart_type, title, labels, values)`: draw a pie/line/bar "
    "chart. Pass the labels and values returned by aggregate_invoices verbatim.\n"
    "- `list_invoices`: raw fields of every invoice — only for inspecting or "
    "listing, NOT for math.\n"
    "- `read_invoice(name)`: full detail of one invoice, for line-item or "
    "specific-invoice questions.\n"
    "\n"
    "Rules:\n"
    "- NEVER add up or compute figures yourself — always call "
    "aggregate_invoices and report its numbers exactly. Doing arithmetic by hand "
    "is forbidden because it is error-prone.\n"
    "- For a chart, call aggregate_invoices first, then render_chart with those "
    "exact labels/values, then give a one-line text takeaway.\n"
    "- If there are no invoices, or a needed field is missing, say so plainly. "
    "If aggregate reports multiple currencies, flag that you should not sum "
    "across them."
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "aggregate_invoices",
            "description": (
                "Exact total/count/breakdown across all invoices, computed in "
                "code. Use this for every number and chart."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "metric": {
                        "type": "string",
                        "enum": ["total_amount", "tax_amount", "count"],
                    },
                    "group_by": {
                        "type": "string",
                        "enum": ["buyer_state", "seller_state", "currency", "month"],
                        "description": "Omit for a grand total.",
                    },
                },
                "required": ["metric"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_invoices",
            "description": (
                "List all stored invoices with their structured fields "
                "(amounts, tax, state, date, parties). Use for aggregation."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_invoice",
            "description": "Read the full detail of one invoice by its name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Invoice name."}
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "render_chart",
            "description": (
                "Render a chart in the UI from already-aggregated data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_type": {
                        "type": "string",
                        "enum": ["pie", "line", "bar"],
                    },
                    "title": {"type": "string"},
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Category/x-axis labels.",
                    },
                    "values": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "Numeric value per label, same order.",
                    },
                },
                "required": ["chart_type", "title", "labels", "values"],
            },
        },
    },
]

_MAX_ROUNDS = 6


async def _run_tool(
    name: str, args: dict, chart_box: list[ChartSpec], sources: set[str]
) -> str:
    if name == "aggregate_invoices":
        return json.dumps(
            aggregate(args.get("metric", "total_amount"), args.get("group_by"))
        )
    if name == "list_invoices":
        return json.dumps(list_invoices())
    if name == "read_invoice":
        inv = args.get("name", "")
        content = read_invoice(inv)
        if content is None:
            return "Invoice not found."
        sources.add(inv)  # record the invoice the agent actually used
        return content
    if name == "render_chart":
        labels = [str(x) for x in args.get("labels", [])]
        values = [float(v) for v in args.get("values", [])]
        chart_box.append(
            ChartSpec(
                type=args.get("chart_type", "bar"),
                title=args.get("title", ""),
                labels=labels,
                values=values,
            )
        )
        return json.dumps({"ok": True, "rendered": len(labels)})
    return json.dumps({"error": f"unknown tool {name}"})


async def answer_question(
    question: str,
    history: list[dict] | None = None,
) -> AskResponse:
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": question})

    chart_box: list[ChartSpec] = []
    sources: set[str] = set()

    for _ in range(_MAX_ROUNDS):
        completion = await chat_completion(
            model=settings.llm_model,
            messages=messages,
            tools=TOOLS,
            temperature=0.1,
        )
        msg = completion.choices[0].message

        if not msg.tool_calls:
            return AskResponse(
                answer=msg.content or "",
                chart=chart_box[-1] if chart_box else None,
                sources=sorted(sources),
            )

        messages.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            result = await _run_tool(call.function.name, args, chart_box, sources)
            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": result}
            )

    # Ran out of rounds — return whatever we have.
    return AskResponse(
        answer=(
            "I wasn't able to finish answering that. Please try rephrasing or "
            "narrowing the question."
        ),
        chart=chart_box[-1] if chart_box else None,
        sources=sorted(sources),
    )
