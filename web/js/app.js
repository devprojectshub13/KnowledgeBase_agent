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
function confirmDialog(text) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-overlay");
    $("#confirm-text").textContent = text;
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
      `<div class="doc-item-body">` +
      `<span class="doc-item-name">${escapeHtml(d.invoice_no || d.name)}</span>` +
      `<span class="doc-item-meta">${escapeHtml(meta)}</span></div>` +
      `<button class="doc-del" title="Delete invoice" aria-label="Delete">${TRASH_SVG}</button>`;
    item
      .querySelector(".doc-del")
      .addEventListener("click", () => deleteInvoice(d.name, d.invoice_no || d.name));
    list.appendChild(item);
  });
}

async function deleteInvoice(name, label) {
  const ok = await confirmDialog(`Delete invoice "${label}"?`);
  if (!ok) return;
  try {
    const r = await fetch(`/invoices/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error("Delete failed");
    logIngest(`🗑 removed "${label}"`);
  } catch {
    logIngest(`✕ could not delete "${label}"`, true);
  }
  loadInvoices();
}

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
  wireSamples();
}

function addMessage(role, text, chart) {
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

  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

/* ---------- charts (monochrome) ---------- */
function grayscale(n) {
  if (n <= 1) return ["#1a1a1a"];
  return Array.from({ length: n }, (_, i) => {
    const v = Math.round(26 + (200 - 26) * (i / (n - 1)));
    return `rgb(${v},${v},${v})`;
  });
}

function buildChart(spec) {
  const box = document.createElement("div");
  box.className = "chart-box";
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);

  const isPie = spec.type === "pie";
  const colors = grayscale(spec.values.length);
  const data = {
    labels: spec.labels,
    datasets: [
      {
        label: spec.title,
        data: spec.values,
        backgroundColor: isPie ? colors : "rgba(26,26,26,0.85)",
        borderColor: "#1a1a1a",
        borderWidth: isPie ? 1 : 2,
        fill: false,
        tension: 0.25,
        pointBackgroundColor: "#1a1a1a",
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
    addMessage("assistant", data.answer || "(no answer)", data.chart);
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

/* ---------- sample question chips ---------- */
function wireSamples() {
  document.querySelectorAll(".sample").forEach((b) =>
    b.addEventListener("click", () => sendQuestion(b.textContent.trim()))
  );
}

/* ---------- new chat ---------- */
$("#new-chat").addEventListener("click", () => {
  resetThread();
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
    msgs.forEach((m) => addMessage(m.role, m.content));
  } catch {
    /* offline */
  }
}

/* ---------- init ---------- */
setSessionLabel();
wireSamples();
restoreSession();
loadInvoices();
ping();
setInterval(ping, 15000);
