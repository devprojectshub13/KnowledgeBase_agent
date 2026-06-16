"""Invoice ingestion: parse a file to markdown, extract structured fields with
the LLM, and return them. This is the ``write`` side of the pipeline — it pulls
every useful field (plus anything else the model spots) so we never have to
re-upload to answer a new kind of question later."""

import json
import re

from app.config import settings
from app.llm import chat_completion

_EXTRACT_SYSTEM = (
    "You extract structured data from a single invoice, given as markdown. "
    "Return ONLY a JSON object with these keys:\n"
    "- invoice_no (string — the SELLER'S invoice/bill number, usually labelled "
    "'Invoice No'. It is NOT the PO/order number, NOT the IRN/ACK, and NOT any "
    "reference/challan number. If unsure, pick the value next to 'Invoice No'.)\n"
    "- invoice_date (ISO yyyy-mm-dd; convert from any format)\n"
    "- due_date (ISO yyyy-mm-dd or null)\n"
    "- seller_name, seller_state, seller_gstin (strings)\n"
    "- buyer_name, buyer_state (the 'place of supply'), buyer_gstin (strings)\n"
    "- currency (ISO code like INR/USD/EUR; infer from symbols)\n"
    "- taxable_value (number — total amount BEFORE tax / sum of taxable values)\n"
    "- cgst, sgst, igst (numbers or null — the tax components)\n"
    "- tax_amount (number — total tax = cgst+sgst+igst, or total VAT/GST)\n"
    "- total_amount (number — the grand total payable)\n"
    "- po_number (string or null)\n"
    "- hsn_codes (array of distinct HSN/SAC code strings)\n"
    "- line_items (array of objects: description, hsn, quantity, rate, amount)\n"
    "- additional_fields (object — ANY other useful fields present on the invoice "
    "that aren't listed above, e.g. irn, eway_bill_no, vehicle_no, transporter, "
    "payment_terms, place_of_supply, reverse_charge. Think about what could be "
    "useful for analytics and include it with clear snake_case keys. Use {} if "
    "there is nothing extra.)\n"
    "Rules: copy numbers exactly as printed (no currency symbols or thousands "
    "separators). Use null for absent scalars, [] / {} for absent lists/objects. "
    "Never invent values. Output JSON only, no prose."
)

# Scalar fields coerced to numbers.
_NUMERIC = {
    "taxable_value",
    "cgst",
    "sgst",
    "igst",
    "tax_amount",
    "total_amount",
}
# Scalar fields kept as-is (strings / null).
_STRINGS = [
    "invoice_no",
    "invoice_date",
    "due_date",
    "seller_name",
    "seller_state",
    "seller_gstin",
    "buyer_name",
    "buyer_state",
    "buyer_gstin",
    "currency",
    "po_number",
]


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
    duplicate check). The body is the FULL parsed markdown, so no source detail
    is lost and any new field can be re-derived later."""
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

    fields: dict = {key: raw.get(key) for key in _STRINGS}
    fields["invoice_no"] = fields.get("invoice_no") or filename
    for key in _NUMERIC:
        fields[key] = _to_number(raw.get(key))
    fields["hsn_codes"] = raw.get("hsn_codes") or []
    fields["line_items"] = raw.get("line_items") or []
    extra = raw.get("additional_fields")
    fields["additional_fields"] = extra if isinstance(extra, dict) else {}
    fields["source_file"] = filename

    # Keep the complete parsed text so nothing useful is ever discarded.
    return fields, markdown.strip()
