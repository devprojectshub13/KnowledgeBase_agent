"""Invoice ingestion: parse a file to markdown, extract structured fields with
the LLM, and write one invoice markdown file. This is the ``write`` side of the
pipeline — it decides what is worth saving and stores it in a queryable shape."""

import json
import re

from app.config import settings
from app.llm import chat_completion

_EXTRACT_SYSTEM = (
    "You extract structured data from a single invoice. You are given the "
    "invoice as markdown. Return ONLY a JSON object with these keys:\n"
    "- invoice_no (string)\n"
    "- invoice_date (string, ISO yyyy-mm-dd; convert from any format)\n"
    "- seller_name (string — the company issuing the invoice)\n"
    "- seller_state (string — state/region of the seller)\n"
    "- buyer_name (string)\n"
    "- buyer_state (string — state/region of the buyer; the 'place of supply')\n"
    "- currency (string, ISO code like INR/USD/EUR; infer from symbols)\n"
    "- total_amount (number — the grand total payable, no currency symbol or "
    "thousands separators)\n"
    "- tax_amount (number — total tax: sum of CGST+SGST+IGST/VAT/GST)\n"
    "- summary (string — a short markdown summary of the line items)\n"
    "Use null for any field genuinely absent. Never guess amounts; copy the "
    "numbers exactly as printed. Output JSON only, no prose."
)

# Fields persisted to frontmatter (everything except the free-text summary).
_NUMERIC = {"total_amount", "tax_amount"}


def _to_number(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    try:
        return float(cleaned) if cleaned not in ("", "-", ".") else None
    except ValueError:
        return None


async def extract_invoice(filename: str, markdown: str) -> tuple[dict, str]:
    """Extract structured fields from invoice markdown. Returns (fields, body)
    WITHOUT persisting — the caller decides how to store it (e.g. after a
    duplicate check)."""
    resp = await chat_completion(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": _EXTRACT_SYSTEM},
            {"role": "user", "content": markdown},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    raw = json.loads(resp.choices[0].message.content or "{}")

    fields = {
        "invoice_no": (raw.get("invoice_no") or filename),
        "invoice_date": raw.get("invoice_date"),
        "seller_name": raw.get("seller_name"),
        "seller_state": raw.get("seller_state"),
        "buyer_name": raw.get("buyer_name"),
        "buyer_state": raw.get("buyer_state"),
        "currency": raw.get("currency"),
        "total_amount": _to_number(raw.get("total_amount")),
        "tax_amount": _to_number(raw.get("tax_amount")),
        "source_file": filename,
    }
    # Body: the model's line-item summary, falling back to the raw markdown.
    body = (raw.get("summary") or markdown).strip()
    return fields, body
