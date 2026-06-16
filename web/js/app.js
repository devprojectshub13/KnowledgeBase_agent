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
  return DOMPurify.sanitize(parse(s || ""));
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
    (await r.json()).forEach((m) => addMessage(m.role, m.content, m.chart, m.sources));
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
  try {
    const r = await fetch(`/invoices/${encodeURIComponent(name)}`);
    const data = await safeJson(r);
    if (!r.ok) throw new Error(data.detail || "Not found");
    body.innerHTML = renderMarkdown("```yaml\n" + (data.content || "") + "\n```");
  } catch (err) {
    body.innerHTML = `<div class="preview-loading err">${escapeHtml(err.message)}</div>`;
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

$("#file-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    logIngest("✕ No file selected", true);
    return;
  }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Extracting…";
  let ok = 0;
  for (const file of files) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/ingest/file", { method: "POST", body: fd });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.detail || "Extraction failed");
      ok++;
      logIngest(`✓ ${data.invoice_no || data.name} — ${data.currency || ""} ${formatMoney(data.total_amount)}`);
    } catch (err) {
      logIngest(`✕ ${file.name}: ${err.message}`, true);
    }
  }
  btn.disabled = false;
  btn.textContent = "Extract & Store";
  fileInput.value = "";
  setFileName(null);
  if (ok) loadInvoices();
});

/* ---------- chat ---------- */
const thread = $("#thread");
const EMPTY_STATE_HTML = $("#empty-state").outerHTML;

function clearEmptyState() {
  $("#empty-state")?.remove();
}

function resetThread() {
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  setSessionLabel();
  thread.innerHTML = EMPTY_STATE_HTML;
}

function addMessage(role, text, chart, sources) {
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
  }
  if (chart) wrap.append(buildChart(chart));
  if (sources && sources.length) wrap.append(buildSources(sources));

  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

function buildSources(names) {
  const box = document.createElement("div");
  box.className = "src-chips";
  box.innerHTML = `<span class="src-label">Used:</span>`;
  names.forEach((n) => {
    const chip = document.createElement("button");
    chip.className = "src-chip";
    chip.textContent = n;
    chip.title = `Preview ${n}`;
    chip.addEventListener("click", () => openPreview(n, n));
    box.appendChild(chip);
  });
  return box;
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
    addMessage("assistant", data.answer || "(no answer)", data.chart, data.sources);
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

/* ---------- persistent sample chips ---------- */
document.querySelectorAll(".sample").forEach((b) =>
  b.addEventListener("click", () => sendQuestion(b.textContent.trim()))
);

/* ---------- new chat ---------- */
$("#new-chat").addEventListener("click", () => {
  resetThread();
  loadSessions();
  askInput.focus();
});

/* ---------- restore active session ---------- */
async function restoreSession() {
  if (!sessionId) return;
  try {
    const r = await fetch(`/sessions/${sessionId}/messages`);
    if (!r.ok) {
      localStorage.removeItem(SESSION_KEY);
      sessionId = null;
      return;
    }
    const msgs = await r.json();
    if (msgs.length) clearEmptyState();
    msgs.forEach((m) => addMessage(m.role, m.content, m.chart, m.sources));
  } catch {
    /* offline */
  }
}

/* ---------- init ---------- */
setSessionLabel();
restoreSession();
loadSessions();
loadInvoices();
ping();
setInterval(ping, 15000);
