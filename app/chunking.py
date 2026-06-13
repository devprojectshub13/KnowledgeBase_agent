import json
import re

import tiktoken

from app.config import settings
from app.llm import chat_completion

# text-embedding-3-* use the cl100k_base tokenizer.
_enc = tiktoken.get_encoding("cl100k_base")


def _token_len(text: str) -> int:
    return len(_enc.encode(text))


def _token_split(text: str, max_tokens: int) -> list[str]:
    """Hard token-window split — last resort for a single oversized line."""
    tokens = _enc.encode(text)
    return [
        _enc.decode(tokens[i : i + max_tokens]).strip()
        for i in range(0, len(tokens), max_tokens)
    ]


def structural_split(text: str, max_tokens: int) -> list[str]:
    """Split text into <= max_tokens segments on line boundaries, never cutting
    mid-line. Greedily packs whole lines; only a single line that alone exceeds
    the limit is token-split. This is the reliable fallback / pre-splitter."""
    segments: list[str] = []
    current: list[str] = []
    current_tok = 0

    def flush():
        nonlocal current, current_tok
        if current:
            joined = "\n".join(current).strip()
            if joined:
                segments.append(joined)
        current, current_tok = [], 0

    for line in text.split("\n"):
        lt = _token_len(line) + 1  # +1 approximates the newline
        if lt > max_tokens:
            flush()
            segments.extend(_token_split(line, max_tokens))
            continue
        if current and current_tok + lt > max_tokens:
            flush()
        current.append(line)
        current_tok += lt
    flush()
    return segments


# ---------------------------------------------------------------------------
# Semantic chunking via LLM "anchors": the model returns only short verbatim
# snippets marking where each new section begins, and we split the ORIGINAL
# text locally at those points. The model never echoes the full text, so dense
# special-character content (code, file trees) can't corrupt the JSON.
# ---------------------------------------------------------------------------

_ANCHOR_SYSTEM = (
    "You segment documents into semantically coherent sections for a retrieval "
    "system. You are given text. Identify the points where a new section should "
    "begin (topic shifts, new headings, distinct components).\n"
    'Return ONLY JSON: {{"breaks": ["...", "..."]}} where each item is the '
    "first 4-10 words of a section, COPIED VERBATIM from the text exactly as it "
    "appears (same characters, spacing, punctuation) so it can be located.\n"
    "- Do NOT include the very first section (the text already starts there).\n"
    "- Order the breaks as they appear in the text.\n"
    "- Aim for sections of roughly {target} tokens; prefer natural boundaries.\n"
    "- If the text is short or covers one topic, return an empty list."
)


def _parse_breaks(raw: str) -> list[str]:
    text = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    breaks = data.get("breaks") if isinstance(data, dict) else data
    if not isinstance(breaks, list):
        return []
    return [b.strip() for b in breaks if isinstance(b, str) and b.strip()]


def _find_anchor(text: str, anchor: str, start: int) -> int:
    """Locate an anchor in text at or after `start`. Tries exact match first,
    then a whitespace-insensitive match (the model may normalise spacing)."""
    idx = text.find(anchor, start)
    if idx != -1:
        return idx
    # Whitespace-tolerant: match the anchor's tokens with flexible gaps.
    pattern = r"\s+".join(re.escape(w) for w in anchor.split())
    m = re.search(pattern, text[start:])
    return start + m.start() if m else -1


def _split_at_anchors(text: str, anchors: list[str]) -> list[str]:
    offsets = [0]
    cursor = 0
    for a in anchors:
        idx = _find_anchor(text, a, cursor)
        if idx > offsets[-1]:
            offsets.append(idx)
            cursor = idx
    offsets.append(len(text))
    out = []
    for i in range(len(offsets) - 1):
        piece = text[offsets[i] : offsets[i + 1]].strip()
        if piece:
            out.append(piece)
    return out


async def _semantic_chunk_window(window: str) -> list[str]:
    system = _ANCHOR_SYSTEM.format(target=settings.chunk_target_tokens)
    resp = await chat_completion(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": window},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    anchors = _parse_breaks(resp.choices[0].message.content or "")
    chunks = _split_at_anchors(window, anchors) if anchors else [window]

    # Guarantee no chunk is wildly oversized (model may under-segment).
    ceiling = settings.chunk_target_tokens * 3
    result: list[str] = []
    for c in chunks:
        if _token_len(c) > ceiling:
            result.extend(structural_split(c, settings.chunk_target_tokens))
        else:
            result.append(c)
    return result


async def semantic_chunk(content: str) -> list[str]:
    """LLM-driven semantic chunking. Large documents are pre-split into
    line-aligned windows; each window is segmented via anchors. Falls back to
    structural (line-aware) splitting if the LLM call fails."""
    content = content.strip()
    if not content:
        return []

    windows = (
        [content]
        if _token_len(content) <= settings.semantic_chunk_max_tokens
        else structural_split(content, settings.semantic_chunk_max_tokens)
    )

    result: list[str] = []
    for window in windows:
        try:
            result.extend(await _semantic_chunk_window(window))
        except Exception:
            # Never fail ingestion — degrade to line-aware structural splitting.
            result.extend(structural_split(window, settings.chunk_target_tokens))
    return result
