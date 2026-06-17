"use strict";

const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = "invoice-agent.session";

let sessionId = localStorage.getItem(SESSION_KEY) || null;

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Safe markdown via marked + DOMPurify (both vendored).
function renderMarkdown(s) {
  const parse = typeof marked.parse === "function" ? marked.parse : marked;
  return DOMPurify.sanitize(parse(prepareMarkdown(s || "")));
}

// If the content starts with a YAML front-matter block (--- ... ---),
// pull it out and render it as a clean key/value table instead of letting
// marked squash it into a paragraph. Everything after the block is left
// alone, except we wrap raw OCR text in a code fence so stray dash-rows
// don't get parsed as markdown tables.
function prepareMarkdown(s) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return s;
  return yamlToTable(m[1]);
}

// Lightweight YAML → markdown table. Handles top-level scalars, empty lists
// ([]), and a `line_items:` list of dash-prefixed objects. Skips null/empty
// values so the table stays compact. Not a real YAML parser — just enough
// for the invoice payloads this app stores.
function yamlToTable(yaml) {
  const lines = yaml.split(/\r?\n/);
  const fields = [];
  const items = [];
  let inItems = false;
  let current = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    if (/^line_items:\s*$/.test(raw)) { inItems = true; continue; }

    if (inItems) {
      const dash = /^\s*-\s*(.+?):\s*(.*)$/.exec(raw);
      const kv = /^\s{2,}(.+?):\s*(.*)$/.exec(raw);
      if (dash) {
        current = {};
        items.push(current);
        current[dash[1].trim()] = dash[2].trim();
      } else if (kv && current) {
        current[kv[1].trim()] = kv[2].trim();
      }
      continue;
    }

    const top = /^([^:]+):\s*(.*)$/.exec(raw);
    if (top) fields.push([top[1].trim(), top[2].trim()]);
  }

  const isEmpty = (v) =>
    v === "" || v === "null" || v === "[]" || v === "{}" || v == null;

  let out = "| Field | Value |\n|---|---|\n";
  for (const [k, v] of fields) {
    if (isEmpty(v)) continue;
    out += `| ${k} | ${escapePipes(v)} |\n`;
  }

  if (items.length) {
    out += "\n**Line items**\n\n";
    const keys = Array.from(
      items.reduce((set, it) => {
        Object.keys(it).forEach((k) => !isEmpty(it[k]) && set.add(k));
        return set;
      }, new Set())
    );
    out += "| " + keys.join(" | ") + " |\n";
    out += "|" + keys.map(() => "---").join("|") + "|\n";
    for (const it of items) {
      out += "| " + keys.map((k) => escapePipes(it[k] || "")).join(" | ") + " |\n";
    }
  }
  return out;
}

function escapePipes(v) {
  return String(v).replace(/\|/g, "\\|");
}

async function safeJson(r) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

function logIngest(message, isError) {
  const el = document.createElement("div");
  el.className = "log-item" + (isError ? " err" : "");
  el.textContent = message;
  const log = $("#ingest-log");
  log.prepend(el);
  while (log.children.length > 8) log.lastChild.remove();
}

function setSessionLabel() {
  $("#session-label").textContent = sessionId
    ? `Session ${sessionId.slice(0, 8)}`
    : "No active session";
}

function relativeTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatMoney(n) {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toLocaleString();
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/* ---------- connection status ---------- */
async function ping() {
  const dot = $("#status-dot");
  try {
    const r = await fetch("/health");
    dot.className = r.ok ? "dot online" : "dot offline";
    dot.title = r.ok ? "online" : "offline";
  } catch {
    dot.className = "dot offline";
    dot.title = "offline";
  }
}

/* ---------- confirmation modal ---------- */
function confirmDialog(text, sub) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-overlay");
    $("#confirm-text").textContent = text;
    $("#confirm-sub").textContent = sub || "This cannot be undone.";
    overlay.classList.remove("hidden");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    const cleanup = (val) => {
      overlay.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => e.target === overlay && cleanup(false);
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

/* ---------- session history sidebar ---------- */
async function loadSessions() {
  const list = $("#session-list");
  let sessions = [];
  try {
    const r = await fetch("/sessions");
    if (r.ok) sessions = await r.json();
  } catch {
    return;
  }
  if (!sessions.length) {
    list.innerHTML = `<p class="session-empty">No conversations yet.</p>`;
    return;
  }
  list.innerHTML = "";
  sessions.forEach((s) => {
    const item = document.createElement("div");
    item.className = "session-item" + (s.session_id === sessionId ? " active" : "");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.innerHTML =
      `<div class="session-item-body">` +
      `<span class="session-item-title">${escapeHtml(s.title)}</span>` +
      `<span class="session-item-meta">${s.message_count} msg · ${relativeTime(s.last_active)}</span>` +
      `</div>` +
      `<button class="session-del" title="Delete conversation" aria-label="Delete">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ` +
      `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>` +
      `<path d="M10 11v6M14 11v6"/></svg></button>`;
    item.addEventListener("click", () => switchSession(s.session_id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") switchSession(s.session_id);
    });
    item.querySelector(".session-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.session_id);
    });
    list.appendChild(item);
  });
}

async function switchSession(id) {
  if (id === sessionId) return;
  hideSuggestions();
  sessionId = id;
  localStorage.setItem(SESSION_KEY, id);
  setSessionLabel();
  thread.innerHTML = "";
  await loadMessages(id);
  loadSessions();
}

async function loadMessages(id) {
  try {
    const r = await fetch(`/sessions/${id}/messages`);
    thread.innerHTML = "";
    if (!r.ok) return;
    (await r.json()).forEach((m) =>
      addMessage(m.role, m.content, m.chart, m.sources, m.aggregated)
    );
  } catch {
    /* offline */
  }
}

async function deleteSession(id) {
  if (!(await confirmDialog("Delete this conversation?",
    "This removes the conversation and its messages."))) return;
  try {
    const r = await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error();
  } catch {
    return;
  }
  if (id === sessionId) resetThread();
  loadSessions();
}

/* ---------- invoices ---------- */
const TRASH_SVG =
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>` +
  `<path d="M10 11v6M14 11v6"/></svg>`;

async function loadInvoices() {
  const list = $("#inv-list");
  let invs = [];
  try {
    const r = await fetch("/invoices");
    if (r.ok) invs = await r.json();
  } catch {
    return;
  }
  $("#inv-count").textContent = invs.length
    ? `${invs.length} invoice${invs.length > 1 ? "s" : ""}`
    : "";
  if (!invs.length) {
    list.innerHTML = `<p class="docs-empty">No invoices yet.</p>`;
    return;
  }
  list.innerHTML = "";
  invs.forEach((d) => {
    const item = document.createElement("div");
    item.className = "doc-item";
    const meta =
      `${d.buyer_state || "—"} · ${d.invoice_date || "—"}` +
      ` · ${d.currency || ""} ${formatMoney(d.total_amount)}`;
    item.innerHTML =
      `<button class="doc-item-body" title="Preview ${escapeHtml(d.invoice_no || d.name)}">` +
      `<span class="doc-item-name">${escapeHtml(d.invoice_no || d.name)}</span>` +
      `<span class="doc-item-meta">${escapeHtml(meta)}</span></button>` +
      `<button class="doc-del" title="Delete invoice" aria-label="Delete">${TRASH_SVG}</button>`;
    item
      .querySelector(".doc-item-body")
      .addEventListener("click", () => openPreview(d.name, d.invoice_no || d.name));
    item
      .querySelector(".doc-del")
      .addEventListener("click", () => deleteInvoice(d.name, d.invoice_no || d.name));
    list.appendChild(item);
  });
}

async function deleteInvoice(name, label) {
  if (!(await confirmDialog(`Delete invoice "${label}"?`,
    "This permanently removes the stored invoice."))) return;
  try {
    const r = await fetch(`/invoices/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error();
    logIngest(`🗑 removed "${label}"`);
  } catch {
    logIngest(`✕ could not delete "${label}"`, true);
  }
  loadInvoices();
}

/* ---------- invoice preview modal ---------- */
async function openPreview(name, label) {
  const overlay = $("#preview-overlay");
  $("#preview-title").textContent = label || name;
  const body = $("#preview-body");
  body.innerHTML = `<div class="preview-loading">Loading…</div>`;
  overlay.classList.remove("hidden");

  const origUrl = `/invoices/${encodeURIComponent(name)}/original`;
  let hasOrig = false;
  try {
    hasOrig = (await fetch(origUrl, { method: "HEAD" })).ok;
  } catch {
    /* offline */
  }

  body.innerHTML =
    `<div class="preview-tabs">` +
    (hasOrig ? `<button class="ptab" id="tab-orig">Original document</button>` : "") +
    `<button class="ptab" id="tab-data">Extracted data</button>` +
    (hasOrig ? `<a class="ptab ptab--dl" href="${origUrl}" download>Download</a>` : "") +
    `</div><div class="preview-pane" id="preview-pane"></div>`;

  const pane = $("#preview-pane");
  const setActive = (id) =>
    body.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.id === id));

const showOriginal = () => {
  pane.innerHTML = `<iframe class="preview-frame" src="${origUrl}#view=FitH" title="${escapeHtml(label || name)}"></iframe>`;
  setActive("tab-orig");
};
  const showData = async () => {
    pane.innerHTML = `<div class="preview-loading">Loading…</div>`;
    try {
      const r = await fetch(`/invoices/${encodeURIComponent(name)}`);
      const d = await safeJson(r);
      if (!r.ok) throw new Error(d.detail || "Not found");
      const html = renderMarkdown(d.content || "");
      pane.innerHTML = `<div class="preview-doc">${html}</div>`;
      enhanceCopyable(pane);
    } catch (err) {
      pane.innerHTML = `<div class="preview-loading err">${escapeHtml(err.message)}</div>`;
    }
    setActive("tab-data");
  };

  $("#tab-data").addEventListener("click", showData);
  if (hasOrig) {
    $("#tab-orig").addEventListener("click", showOriginal);
    showOriginal(); // default to the real document
  } else {
    showData();
  }
}

function closePreview() {
  $("#preview-overlay").classList.add("hidden");
}
$("#preview-close").addEventListener("click", closePreview);
$("#preview-overlay").addEventListener("mousedown", (e) => {
  if (e.target.id === "preview-overlay") closePreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#preview-overlay").classList.contains("hidden")) closePreview();
});

/* ---------- upload ---------- */
const fileInput = $("#file-input");
const dropzone = $("#dropzone");

function setFileName(files) {
  const n = files?.length || 0;
  $("#dropzone-text").textContent =
    n === 0 ? "Choose invoice(s) or drop here" : n === 1 ? files[0].name : `${n} files selected`;
  dropzone.classList.toggle("has-file", n > 0);
}
fileInput.addEventListener("change", () => setFileName(fileInput.files));
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, () => dropzone.classList.remove("drag"))
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    setFileName(fileInput.files);
  }
});

// Duplicate dialog → resolves "replace" | "keep_both" | null (cancel).
function duplicateDialog(info) {
  return new Promise((resolve) => {
    const overlay = $("#dup-overlay");
    $("#dup-sub").textContent =
      `${info.invoice_no || "This invoice"} from ${info.seller_name || "this seller"} ` +
      `is already stored. Replace it, or keep both copies?`;
    overlay.classList.remove("hidden");
    const replace = $("#dup-replace");
    const keep = $("#dup-keep");
    const cancel = $("#dup-cancel");
    const cleanup = (val) => {
      overlay.classList.add("hidden");
      replace.removeEventListener("click", onReplace);
      keep.removeEventListener("click", onKeep);
      cancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      resolve(val);
    };
    const onReplace = () => cleanup("replace");
    const onKeep = () => cleanup("keep_both");
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => e.target === overlay && cleanup(null);
    replace.addEventListener("click", onReplace);
    keep.addEventListener("click", onKeep);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    replace.focus();
  });
}

async function uploadOne(file, onDuplicate) {
  const fd = new FormData();
  fd.append("file", file);
  if (onDuplicate) fd.append("on_duplicate", onDuplicate);
  const r = await fetch("/ingest/file", { method: "POST", body: fd });
  return { status: r.status, data: await safeJson(r) };
}

// One file: interactive, so the user can resolve a duplicate.
async function uploadSingle(file) {
  let res = await uploadOne(file);
  if (res.status === 409) {
    const choice = await duplicateDialog(res.data.detail || {});
    if (!choice) {
      logIngest(`↪ skipped duplicate ${file.name}`);
      return 0;
    }
    res = await uploadOne(file, choice);
  }
  if (res.status < 200 || res.status >= 300) {
    logIngest(`✕ ${file.name}: ${res.data.detail?.message || res.data.detail || "failed"}`, true);
    return 0;
  }
  const d = res.data;
  logIngest(`✓ ${d.invoice_no || d.name} — ${d.currency || ""} ${formatMoney(d.total_amount)}`);
  return 1;
}

// Many files: extracted concurrently server-side; duplicates skipped by default.
async function uploadBulk(files) {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  logIngest(`⟳ extracting ${files.length} invoices in parallel…`);
  const r = await fetch("/ingest/files", { method: "POST", body: fd });
  const data = await safeJson(r);
  if (!r.ok) {
    logIngest(`✕ bulk upload failed: ${data.detail || r.status}`, true);
    return 0;
  }
  (data.results || []).forEach((res) => {
    if (res.status === "duplicate") logIngest(`↪ duplicate skipped: ${res.invoice_no || res.filename}`);
    else if (res.status === "error") logIngest(`✕ ${res.filename}: ${res.detail}`, true);
  });
  const s = data.summary;
  logIngest(`✓ ${s.stored} stored · ${s.duplicates} duplicate(s) · ${s.errors} error(s)`);
  return s.stored;
}

$("#file-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    logIngest("✕ No file selected", true);
    return;
  }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = files.length > 1 ? `Extracting ${files.length}…` : "Extracting…";

  let stored = 0;
  if (files.length === 1) {
    stored = await uploadSingle(files[0]);
  } else {
    stored = await uploadBulk(files);
  }

  btn.disabled = false;
  btn.textContent = "Extract & Store";
  fileInput.value = "";
  setFileName(null);
  if (stored) loadInvoices();
});

/* ---------- chat ---------- */
const thread = $("#thread");

function buildEmptyStateHTML() {
  return `<div class="empty-state" id="empty-state">` +
    `<div class="empty-mark">₹</div>` +
    `<p>Ask about your invoices — totals, tax, and charts.</p>` +
    `</div>`;
}

function clearEmptyState() {
  const empty = $("#empty-state");
  if (empty) empty.remove();
}

function resetThread() {
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  setSessionLabel();
  thread.innerHTML = buildEmptyStateHTML();
  renderSuggestions();
}

function addMessage(role, text, chart, sources, aggregated) {
  clearEmptyState();
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}`;

  const label = document.createElement("div");
  label.className = "msg-role";
  label.textContent = role === "user" ? "You" : "Agent";
  wrap.append(label);

  if (text) {
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = renderMarkdown(text);
    wrap.append(body);
    enhanceCopyable(body);
  }
  if (chart) wrap.append(buildChart(chart));

  // Inline preview cards for the top-3 source invoices (assistant only).
  // The old project's score filter doesn't apply here — `sources` is already
  // a deduped list of invoice names without scores — so we just cap at 3.
  if (role === "assistant" && sources && sources.length) {
    sources.slice(0, 3).forEach((name, i) => {
      wrap.appendChild(buildSourcePreview(name, i + 1));
    });
  }
  if (sources && sources.length) wrap.append(buildSources(sources));
  if (aggregated && aggregated.length) wrap.append(buildAggregated(aggregated));

  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

// Preview chip for one invoice name.
function srcChip(name) {
  const chip = document.createElement("button");
  chip.className = "src-chip";
  chip.textContent = name;
  chip.title = `Preview ${name}`;
  chip.addEventListener("click", () => openPreview(name, name));
  return chip;
}

// Specific invoices the agent read.
function buildSources(names) {
  const box = document.createElement("div");
  box.className = "src-chips";
  box.innerHTML = `<p class="src-label">Used:</p>`;
  names.forEach((n) => box.appendChild(srcChip(n)));
  return box;
}

// Provenance for aggregate answers: "Based on all N invoices" → expands to chips.
function buildAggregated(names) {
  const box = document.createElement("div");
  box.className = "agg-sources";
  const toggle = document.createElement("button");
  toggle.className = "agg-toggle";
  toggle.textContent = `Based on all ${names.length} invoice${names.length > 1 ? "s" : ""}`;
  const list = document.createElement("div");
  list.className = "agg-list";
  names.forEach((n) => list.appendChild(srcChip(n)));
  toggle.addEventListener("click", () => {
    const open = list.classList.toggle("open");
    toggle.classList.toggle("open", open);
  });
  box.append(toggle, list);
  return box;
}

/* ---------- source invoice preview cards (file-type-aware) ---------- */
// Ported from the old Agent · Vector project: chunk-preview inline cards that
// lazily fetch a source and render it differently based on file extension.
const PREVIEW_KIND = {
  pdf: "frame", html: "frame", htm: "frame",
  png: "frame", jpg: "frame", jpeg: "frame", gif: "frame", webp: "frame",
  md: "markdown", markdown: "markdown",
  txt: "text", log: "text", json: "text",
  csv: "csv", tsv: "csv",
};

function buildSourcePreview(name, rank) {
  const box = document.createElement("div");
  box.className = "preview";
  const origUrl = `/invoices/${encodeURIComponent(name)}/original`;

  box.innerHTML =
    `<div class="preview-head">` +
    `<span class="preview-label">Source ${rank}</span>` +
    `<span class="preview-name">${escapeHtml(name)}</span></div>` +
    `<div class="preview-body"></div>` +
    `<div class="preview-actions">` +
    `<button type="button" class="preview-toggle">Preview</button>` +
    `<button type="button" class="preview-open" title="Open in modal">Open</button>` +
    `<a class="preview-dl" href="${origUrl}" download>Download</a></div>`;

  const body = box.querySelector(".preview-body");
  const toggle = box.querySelector(".preview-toggle");
  let loaded = false;

  toggle.addEventListener("click", async () => {
    const open = body.classList.toggle("open");
    toggle.textContent = open ? "Hide" : "Preview";
    if (!open || loaded) return;
    loaded = true;
    try {
      await renderSourcePreview(body, name, origUrl);
    } catch {
      loaded = false;
      body.innerHTML =
        `<div class="preview-loading err">Couldn't load preview. ` +
        `<a href="${origUrl}" download>Download instead</a></div>`;
    }
  });

  box.querySelector(".preview-open").addEventListener("click", () => openPreview(name, name));
  return box;
}

async function renderSourcePreview(body, name, origUrl) {
  const ext = extOf(name);
  const kind = PREVIEW_KIND[ext];

  // Office/binary types we can't render inline — fall back to the extracted
  // YAML so the user still sees the structured data the agent read.
  if (!kind) {
    body.innerHTML = `<div class="preview-loading">Loading extracted data…</div>`;
    const r = await fetch(`/invoices/${encodeURIComponent(name)}`);
    const d = await safeJson(r);
    if (!r.ok) throw new Error();
    const html = renderMarkdown(d.content || "");
    body.innerHTML = `<div class="preview-doc">${html}</div>`;
    enhanceCopyable(body);
    return;
  }

  body.innerHTML = `<div class="preview-loading">Loading…</div>`;
  const r = await fetch(origUrl);
  if (!r.ok) throw new Error();

  if (kind === "frame") {
    const url = URL.createObjectURL(await r.blob());
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.title = name;
    frame.src = ext === "pdf" ? `${url}#toolbar=0&view=FitH` : url;
    body.innerHTML = "";
    body.appendChild(frame);
    return;
  }

  const text = await r.text();
  if (kind === "markdown") {
    body.innerHTML = `<div class="preview-doc">${renderMarkdown(text)}</div>`;
  } else if (kind === "csv") {
    const delim = ext === "tsv" ? "\t" : ",";
    body.innerHTML = `<div class="preview-doc">${csvToTable(text, delim)}</div>`;
  } else {
    const pre = document.createElement("pre");
    pre.className = "preview-pre";
    pre.textContent = text;
    body.innerHTML = "";
    body.appendChild(pre);
  }
}

// Minimal RFC-4180-ish CSV parser (handles quotes and embedded commas/newlines).
function parseCSV(text, delim) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToTable(text, delim) {
  const rows = parseCSV(text, delim).slice(0, 200); // cap for big files
  if (!rows.length) return "";
  const head = rows[0].map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const bodyRows = rows.slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="preview-table"><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

/* ---------- charts ---------- */
// Curated categorical palette (distinct but muted — reads well on white).
const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
];
function palette(n) {
  return Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]);
}

// Draw percentage labels on pie slices.
Chart.register({
  id: "piePercent",
  afterDatasetsDraw(chart) {
    if (chart.config.type !== "pie") return;
    const ctx = chart.ctx;
    const ds = chart.data.datasets[0].data;
    const total = ds.reduce((a, b) => a + (Number(b) || 0), 0);
    if (!total) return;
    ctx.save();
    ctx.font = "600 12px Inter, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chart.getDatasetMeta(0).data.forEach((arc, i) => {
      const pct = ((Number(ds[i]) || 0) / total) * 100;
      if (pct < 4) return; // skip slivers
      const p = arc.tooltipPosition();
      ctx.fillText(pct.toFixed(1) + "%", p.x, p.y);
    });
    ctx.restore();
  },
});

// Export a chart canvas as a PNG (on a white background).
function downloadChart(canvas, title) {
  const tmp = document.createElement("canvas");
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const c = tmp.getContext("2d");
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, tmp.width, tmp.height);
  c.drawImage(canvas, 0, 0);
  const a = document.createElement("a");
  a.href = tmp.toDataURL("image/png");
  a.download = (title || "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png";
  a.click();
}

function buildChart(spec) {
  const box = document.createElement("div");
  box.className = "chart-box";
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);

  const isPie = spec.type === "pie";
  const isBar = spec.type === "bar";
  const cats = palette(spec.values.length);
  const accent = PALETTE[0];
  const data = {
    labels: spec.labels,
    datasets: [
      {
        label: spec.title,
        data: spec.values,
        backgroundColor: isPie || isBar ? cats : "rgba(78,121,167,0.14)",
        borderColor: isPie ? "#ffffff" : accent,
        borderWidth: isPie ? 2 : 2,
        fill: !isPie && !isBar,
        tension: 0.25,
        pointBackgroundColor: accent,
        pointRadius: 3,
      },
    ],
  };
  const options = {
    responsive: true,
    plugins: {
      legend: { display: isPie, position: "right", labels: { font: { family: "Inter" } } },
      title: { display: !!spec.title, text: spec.title, font: { family: "Inter", size: 13 } },
    },
    scales: isPie
      ? {}
      : { y: { beginAtZero: true, grid: { color: "#ececec" } }, x: { grid: { display: false } } },
  };
  new Chart(canvas.getContext("2d"), { type: spec.type, data, options });

  const dl = document.createElement("button");
  dl.className = "chart-dl";
  dl.type = "button";
  dl.textContent = "↓ Download PNG";
  dl.addEventListener("click", () => downloadChart(canvas, spec.title));
  box.appendChild(dl);
  return box;
}

function addTyping() {
  clearEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg msg--assistant msg-typing";
  wrap.innerHTML =
    `<div class="msg-role">Agent</div>` +
    `<div class="msg-body"><span class="dotpulse"></span><span class="dotpulse"></span><span class="dotpulse"></span></div>`;
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

const askInput = $("#ask-input");
askInput.addEventListener("input", () => {
  askInput.style.height = "auto";
  askInput.style.height = Math.min(askInput.scrollHeight, 140) + "px";
});
askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#ask-form").requestSubmit();
  }
});

async function sendQuestion(question) {
  if (!question) return;
  hideSuggestions();
  addMessage("user", question);
  askInput.value = "";
  askInput.style.height = "auto";
  const btn = $("#ask-btn");
  btn.disabled = true;
  const typing = addTyping();
  try {
    const r = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, session_id: sessionId }),
    });
    const data = await safeJson(r);
    typing.remove();
    if (!r.ok) throw new Error(data.detail || "Request failed");
    if (data.session_id) {
      sessionId = data.session_id;
      localStorage.setItem(SESSION_KEY, sessionId);
      setSessionLabel();
    }
    addMessage("assistant", data.answer || "(no answer)", data.chart, data.sources, data.aggregated);
    loadSessions();
  } catch (err) {
    typing.remove();
    addMessage("assistant", `**Error:** ${err.message}`);
  } finally {
    btn.disabled = false;
    askInput.focus();
  }
}

$("#ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendQuestion(askInput.value.trim());
});

/* ---------- suggestions + saved questions ---------- */

const QUESTIONS_CSV_URL = "/static/questions.csv";
const SUGGESTION_COUNT = 3;

// Defensive fallback so the UI never looks empty if questions.csv is missing
// or malformed. Logged to console.warn so dev doesn't silently get fooled.
const FALLBACK_SAMPLES = [
  "Give total tax amount from all invoices",
  "State wise sales pie chart",
  "Company growth line chart by month by sales",
];

let csvQuestions = [];

function parseQuestionsCsv(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.startsWith('"') && line.endsWith('"')
        ? line.slice(1, -1).replace(/""/g, '"')
        : line
    )
    .filter((line) => !/^questions?$/i.test(line));
}

async function loadCsvQuestions() {
  try {
    const r = await fetch(QUESTIONS_CSV_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    csvQuestions = parseQuestionsCsv(await r.text());
    if (!csvQuestions.length) throw new Error("empty");
  } catch (err) {
    console.warn(`[suggestions] questions.csv unavailable (${err.message}); using fallback samples.`);
    csvQuestions = FALLBACK_SAMPLES.slice();
  }
}

function pickRandom(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (pool.length && out.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function sampleChip(q) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "suggestion";
  b.textContent = q;
  b.addEventListener("click", () => {
    askInput.value = q;
    askInput.dispatchEvent(new Event("input")); // auto-grow textarea
    askInput.focus();
  });
  return b;
}

// Render the 3 random onboarding chips into the bar above the composer.
// Only shown when there's no active session; hidden once a question is sent.
function renderSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  // Don't show in the middle of an active conversation.
  if (sessionId) {
    hideSuggestions();
    return;
  }
  if (!csvQuestions.length) {
    hideSuggestions();
    return;
  }
  box.innerHTML = "";
  const label = document.createElement("span");
  label.className = "suggestions-label";
  label.textContent = "Try asking";
  box.appendChild(label);
  pickRandom(csvQuestions, SUGGESTION_COUNT).forEach((q) => box.appendChild(sampleChip(q)));
  box.classList.remove("hidden");
}

function hideSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

// Row 2 — the user's own saved questions, kept across sessions via localStorage.
const SAVED_KEY = "invoice-agent.saved";
// Flip to true once a backend route exists at /save_question that persists
// saved questions to /static/user_question.csv. Until then, keep it false so
// devtools doesn't fill with 404s on every star-save.
const SYNC_SAVED_TO_SERVER = false;
const SAVE_QUESTION_ENDPOINT = "/save_question";

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) || [];
  } catch {
    return [];
  }
}
function setSaved(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

// Best-effort write to the backend; guarded so it doesn't fire until the
// endpoint actually exists.
async function persistSavedQuestion(text) {
  if (!SYNC_SAVED_TO_SERVER) return;
  try {
    await fetch(SAVE_QUESTION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text }),
    });
  } catch {
    /* network down — localStorage already has it, that's enough */
  }
}

async function saveQuestion(text) {
  text = (text || "").trim();
  if (!text) return;
  const list = getSaved();
  if (list.includes(text) || csvQuestions.includes(text)) return; // no dupes
  list.unshift(text);
  setSaved(list);
  renderSaved();
  persistSavedQuestion(text);
}
function deleteSaved(text) {
  setSaved(getSaved().filter((q) => q !== text));
  renderSaved();
}

function renderSaved() {
  const bar = $("#saved-bar");
  const saved = getSaved();
  bar.innerHTML = "";
  if (!saved.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "suggestions-label";
  label.textContent = "Saved";
  bar.appendChild(label);
  saved.forEach((q) => {
    const chip = document.createElement("span");
    chip.className = "saved-chip";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "saved-x";
    del.textContent = "×";
    del.title = "Delete saved question";
    del.addEventListener("click", () => deleteSaved(q));
    chip.append(sampleChip(q), del);
    bar.appendChild(chip);
  });
}

$("#save-q").addEventListener("click", () => {
  saveQuestion(askInput.value);
  askInput.focus();
});

/* ---------- new chat ---------- */
$("#new-chat").addEventListener("click", () => {
  resetThread();
  loadSessions();
  askInput.focus();
});

/* ---------- restore active session ---------- */
async function restoreSession() {
  if (!sessionId) {
    renderSuggestions(); // defensive — show chips if we land with no session
    return;
  }
  try {
    const r = await fetch(`/sessions/${sessionId}/messages`);
    if (!r.ok) {
      localStorage.removeItem(SESSION_KEY);
      sessionId = null;
      renderSuggestions();
      return;
    }
    const msgs = await r.json();
    if (msgs.length) {
      clearEmptyState();
      hideSuggestions();
    } else {
      renderSuggestions(); // empty session — treat like a fresh chat
    }
    msgs.forEach((m) =>
      addMessage(m.role, m.content, m.chart, m.sources, m.aggregated)
    );
  } catch {
    /* offline — leave empty state */
  }
}

/* ---------- copy / excel action buttons ---------- */
function enhanceCopyable(container) {
  // Code blocks → Copy
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = "1";
    const wrap = document.createElement("div");
    wrap.className = "copy-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.appendChild(
      makeActionBtn("Copy", "Copied", async () => {
        await navigator.clipboard.writeText(
          pre.querySelector("code")?.innerText ?? pre.innerText
        );
      })
    );
  });

  // Tables → Download as CSV
  container.querySelectorAll("table").forEach((table) => {
    if (table.dataset.enhanced) return;
    table.dataset.enhanced = "1";
    const wrap = document.createElement("div");
    wrap.className = "copy-wrap copy-wrap--table";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
    wrap.appendChild(
      makeActionBtn("Excel", "Saved", async () => {
        downloadCSV(tableToCSV(table), `table-${Date.now()}.csv`);
      })
    );
  });
}

function makeActionBtn(label, doneLabel, action) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = label;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await action();
      btn.textContent = doneLabel;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1400);
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = label), 1400);
    }
  });
  return btn;
}

function tableToCSV(table) {
  const escape = (s) => {
    s = String(s).replace(/\r?\n/g, " ");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Array.from(table.rows)
    .map((row) =>
      Array.from(row.cells).map((c) => escape(c.innerText.trim())).join(",")
    )
    .join("\r\n");
}

function downloadCSV(csv, filename) {
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- init ---------- */
async function init() {
  setSessionLabel();
  await loadCsvQuestions();
  renderSaved();
  await restoreSession();
  loadSessions();
  loadInvoices();
  ping();
  setInterval(ping, 15000);
}
init();