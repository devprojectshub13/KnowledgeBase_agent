"""Markdown invoice store.

Each invoice is a single ``.md`` file: a YAML frontmatter block of structured
fields (the bits we compute over — amounts, tax, state, date, parties) followed
by a human-readable body. This replaces the vector store: aggregation and charts
read the frontmatter of *every* invoice in one cheap pass, so answers are exact
instead of "best guess from the top-k similar chunks".
"""

import re
from pathlib import Path

import yaml

from app.config import settings

INVOICE_DIR = Path(settings.invoice_dir).resolve()

# Canonical fields we extract per invoice (others are allowed but these drive
# the standard questions: totals, tax, state-wise/time-series charts).
FIELDS = [
    "invoice_no",
    "invoice_date",  # ISO yyyy-mm-dd
    "seller_name",
    "seller_state",
    "buyer_name",
    "buyer_state",
    "currency",
    "total_amount",
    "tax_amount",
]


def _slug(value: str) -> str:
    """Filesystem-safe stem derived from a value (e.g. an invoice number)."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", value.strip()).strip("-").lower()
    return s or "invoice"


def _unique_path(stem: str) -> Path:
    """A non-colliding ``<stem>.md`` path inside the invoice dir."""
    path = INVOICE_DIR / f"{stem}.md"
    n = 2
    while path.exists():
        path = INVOICE_DIR / f"{stem}-{n}.md"
        n += 1
    return path


def _resolve(name: str) -> Path:
    """Resolve a stored name to a path, guarding against traversal."""
    path = (INVOICE_DIR / f"{Path(name).stem}.md").resolve()
    if INVOICE_DIR not in path.parents:
        raise ValueError("invalid invoice name")
    return path


def write_invoice(fields: dict, body: str) -> str:
    """Persist one invoice as ``frontmatter + body`` markdown. The filename is
    derived from the invoice number. Returns the stored name (without ``.md``)."""
    INVOICE_DIR.mkdir(parents=True, exist_ok=True)
    stem = _slug(str(fields.get("invoice_no") or "invoice"))
    path = _unique_path(stem)
    front = yaml.safe_dump(fields, sort_keys=False, allow_unicode=True).strip()
    path.write_text(f"---\n{front}\n---\n\n{body.strip()}\n", encoding="utf-8")
    return path.stem


def _parse(text: str) -> tuple[dict, str]:
    """Split a stored file into (frontmatter dict, body)."""
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    try:
        front = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        front = {}
    return (front if isinstance(front, dict) else {}), m.group(2).strip()


def list_invoices() -> list[dict]:
    """Structured frontmatter for every stored invoice (one compact row each).
    This is what the agent aggregates over for totals and charts."""
    if not INVOICE_DIR.exists():
        return []
    rows: list[dict] = []
    for path in sorted(INVOICE_DIR.glob("*.md")):
        front, _ = _parse(path.read_text(encoding="utf-8"))
        rows.append({"name": path.stem, **front})
    return rows


def aggregate(
    metric: str = "total_amount",
    group_by: str | None = None,
) -> dict:
    """Exact aggregation over invoice frontmatter — computed in Python, never by
    the LLM, so totals and chart values are correct.

    metric: "total_amount" | "tax_amount" | "count".
    group_by: None for a grand total, else a field name ("buyer_state",
    "seller_state", "currency") or "month" (groups invoice_date by yyyy-mm).
    Returns the grand total and, when grouped, sorted {label, value} rows plus
    the set of currencies seen (so the caller can flag mixed-currency sums).
    """
    rows = list_invoices()

    def value_of(row: dict) -> float:
        if metric == "count":
            return 1.0
        return float(row.get(metric) or 0)

    currencies = sorted({r.get("currency") for r in rows if r.get("currency")})
    total = round(sum(value_of(r) for r in rows), 2)

    if not group_by:
        return {
            "metric": metric,
            "group_by": None,
            "total": total,
            "count": len(rows),
            "currencies": currencies,
        }

    groups: dict[str, float] = {}
    for r in rows:
        if group_by == "month":
            key = (str(r.get("invoice_date") or "")[:7]) or "unknown"
        else:
            key = str(r.get(group_by) or "unknown")
        groups[key] = round(groups.get(key, 0.0) + value_of(r), 2)

    # Months read best chronologically; other groupings by descending value.
    items = sorted(
        groups.items(),
        key=(lambda kv: kv[0]) if group_by == "month" else (lambda kv: -kv[1]),
    )
    return {
        "metric": metric,
        "group_by": group_by,
        "total": total,
        "count": len(rows),
        "currencies": currencies,
        "groups": [{"label": k, "value": v} for k, v in items],
    }


def _find(name: str) -> Path | None:
    """Locate an invoice by its stored name OR its invoice number (both
    case-insensitive), so callers can use whichever they have."""
    direct = _resolve(name)
    if direct.exists():
        return direct
    target = name.strip().lower()
    for path in INVOICE_DIR.glob("*.md") if INVOICE_DIR.exists() else []:
        if path.stem.lower() == target:
            return path
        front, _ = _parse(path.read_text(encoding="utf-8"))
        if str(front.get("invoice_no") or "").strip().lower() == target:
            return path
    return None


def read_invoice(name: str) -> str | None:
    """Full markdown content of one invoice (frontmatter + body), truncated to
    the read budget. Accepts the stored name or the invoice number. Returns None
    if not found."""
    path = _find(name)
    if path is None:
        return None
    return path.read_text(encoding="utf-8")[: settings.read_char_limit]


def delete_invoice(name: str) -> bool:
    path = _resolve(name)
    if not path.exists():
        return False
    path.unlink()
    return True
