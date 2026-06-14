"use strict";

const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = "agent-vector.session";

let sessionId = localStorage.getItem(SESSION_KEY) || null;

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Minimal **bold** rendering on top of escaped text.
function renderMarkdown(s) {
  const rawHtml = marked.parse(s, { gfm: true, breaks: true });
  return DOMPurify.sanitize(rawHtml);
}

// Parse a response as JSON, tolerating empty/non-JSON bodies (e.g. proxy 5xx).
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
  while (log.children.length > 6) log.lastChild.remove();
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

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EMPTY_STATE_HTML =
  `<div class="empty-state" id="empty-state"><div class="empty-mark">⌗</div>` +
  `<p>Ask a question grounded in your knowledge base.<br />The agent retrieves, then answers with sources.</p></div>`;

// Reset the conversation pane to the "no active session" empty state.
function resetThread() {
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  setSessionLabel();
  thread.innerHTML = EMPTY_STATE_HTML;
}

/* ---------- session history sidebar ---------- */
async function loadSessions() {
  const list = $("#session-list");
  let sessions = [];
  try {
    const r = await fetch("/sessions");
    if (r.ok) sessions = await r.json();
  } catch {
    return; // offline — leave as-is
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
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(false);
    };
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

async function deleteSession(id) {
  const confirmed = await confirmDialog("Delete this conversation?");
  if (!confirmed) return;
  try {
    const r = await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error("Delete failed");
  } catch {
    return;
  }
  // If the deleted conversation was open, reset to a fresh one.
  if (id === sessionId) resetThread();
  loadSessions();
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
    if (!r.ok) {
      thread.innerHTML = "";
      return;
    }
    const msgs = await r.json();
    thread.innerHTML = "";
    msgs.forEach((m) => addMessage(m.role, m.content));
  } catch {
    /* offline */
  }
}

/* ---------- knowledge-base documents ---------- */
const TRASH_SVG =
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>` +
  `<path d="M10 11v6M14 11v6"/></svg>`;

const DOWNLOAD_SVG =
  `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px">` +
  `<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg>`;

const PAPERCLIP_SVG =
  `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

async function loadDocuments() {
  const list = $("#docs-list");
  let docs = [];
  try {
    const r = await fetch("/documents");
    if (r.ok) docs = await r.json();
  } catch {
    return;
  }
  $("#docs-count").textContent = docs.length
    ? `${docs.length} doc${docs.length > 1 ? "s" : ""}`
    : "";
  if (!docs.length) {
    list.innerHTML = `<p class="docs-empty">No documents yet.</p>`;
    return;
  }
  list.innerHTML = "";
  docs.forEach((d) => {
    const item = document.createElement("div");
    item.className = "doc-item";
    const href = `/documents/${encodeURIComponent(d.document)}/download`;
    const meta =
      `${d.chunks} chunk${d.chunks > 1 ? "s" : ""}` +
      (d.size ? ` · ${formatSize(d.size)}` : "");
    item.innerHTML =
      `<a class="doc-item-body" href="${href}" download title="Download ${escapeHtml(d.document)}">` +
      `<span class="doc-item-name">${escapeHtml(d.document)}</span>` +
      `<span class="doc-item-meta">${DOWNLOAD_SVG} ${meta}</span></a>` +
      `<button class="doc-del" title="Delete document" aria-label="Delete">${TRASH_SVG}</button>`;
    item
      .querySelector(".doc-del")
      .addEventListener("click", () => deleteDocument(d.document));
    list.appendChild(item);
  });
}

async function deleteDocument(name) {
  const ok = await confirmDialog(`Delete "${name}" from the knowledge base?`);
  if (!ok) return;
  try {
    const r = await fetch(`/documents/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!r.ok && r.status !== 404) throw new Error("Delete failed");
    logIngest(`🗑 removed "${name}"`);
  } catch {
    logIngest(`✕ could not delete "${name}"`, true);
  }
  loadDocuments();
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

/* ---------- tab switching ---------- */
document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("#text-form").classList.toggle("hidden", tab !== "text");
    $("#file-form").classList.toggle("hidden", tab !== "file");
  });
});

/* ---------- text ingest ---------- */
$("#text-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const document_ = $("#doc-name").value.trim();
  const content = $("#doc-content").value.trim();
  if (!content) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Ingesting…";
  try {
    const r = await fetch("/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: document_ || "untitled", content }),
    });
    const data = await safeJson(r);
    if (!r.ok) throw new Error(data.detail || "Ingest failed");
    logIngest(`✓ "${data.document}" — ${data.chunks_ingested} chunk(s)`);
    loadDocuments();
    $("#doc-content").value = "";
  } catch (err) {
    logIngest(`✕ ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Ingest Text";
  }
});

/* ---------- file ingest ---------- */
const fileInput = $("#file-input");
const dropzone = $("#dropzone");

function setFileName(name) {
  $("#dropzone-text").textContent = name || "Choose a file or drop it here";
  dropzone.classList.toggle("has-file", !!name);
}
fileInput.addEventListener("change", () =>
  setFileName(fileInput.files[0]?.name)
);
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
  if (e.dataTransfer.files[0]) {
    fileInput.files = e.dataTransfer.files;
    setFileName(e.dataTransfer.files[0].name);
  }
});

$("#file-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    logIngest("✕ No file selected", true);
    return;
  }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Parsing…";
  const fd = new FormData();
  fd.append("file", file);
  const name = $("#doc-name-file").value.trim();
  if (name) fd.append("document", name);
  try {
    const r = await fetch("/ingest/file", { method: "POST", body: fd });
    const data = await safeJson(r);
    if (!r.ok) throw new Error(data.detail || "Parse failed");
    logIngest(`✓ "${data.document}" — ${data.chunks_ingested} chunk(s)`);
    loadDocuments();
    fileInput.value = "";
    setFileName(null);
  } catch (err) {
    logIngest(`✕ ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Parse & Ingest";
  }
});

/* ---------- chat ---------- */
const thread = $("#thread");

function clearEmptyState() {
  $("#empty-state")?.remove();
}

function addMessage(role, text, sources, attachment) {
  clearEmptyState();
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}`;

  const label = document.createElement("div");
  label.className = "msg-role";
  label.textContent = role === "user" ? "You" : "Agent";
  wrap.append(label);

  if (attachment) {
    const file = document.createElement(attachment.id ? "a" : "span");
    file.className = "msg-file";
    if (attachment.id) {
      file.href = `/attachments/${attachment.id}/download`;
      file.setAttribute("download", "");
      file.title = `Download ${attachment.filename}`;
    }
    file.innerHTML =
      `${PAPERCLIP_SVG}<span class="msg-file-name">${escapeHtml(attachment.filename)}</span>` +
      (attachment.size ? `<span class="msg-file-size">${formatSize(attachment.size)}</span>` : "");
    wrap.append(file);
  }

  if (text) {
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = renderMarkdown(text);
    wrap.append(body);
    enhanceCopyable(body);
  }

  if (sources && sources.length) {
    wrap.appendChild(buildSources(sources));
  }
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

function buildSources(sources) {
  const box = document.createElement("div");
  box.className = "sources";

  const toggle = document.createElement("button");
  toggle.className = "sources-toggle";
  toggle.textContent = `${sources.length} source${sources.length > 1 ? "s" : ""}`;

  const list = document.createElement("div");
  list.className = "sources-list";
  sources.forEach((s) => {
    const item = document.createElement("div");
    item.className = "source";
    item.innerHTML =
      `<div class="source-meta"><span>${escapeHtml(s.document)} · #${s.chunk_index}</span>` +
      `<span>${s.score.toFixed(3)}</span></div>` +
      `<div class="source-text">${escapeHtml(s.content.slice(0, 240))}${s.content.length > 240 ? "…" : ""}</div>`;
    list.appendChild(item);
  });

  toggle.addEventListener("click", () => list.classList.toggle("open"));
  box.append(toggle, list);
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

/* ---------- attachment (per-conversation file) ---------- */
const askFileInput = $("#ask-file");
let attachedFile = null;

function renderAttachChip() {
  const chip = $("#attach-chip");
  if (!attachedFile) {
    chip.classList.add("hidden");
    chip.innerHTML = "";
    return;
  }
  chip.classList.remove("hidden");
  chip.innerHTML =
    `${PAPERCLIP_SVG}<span class="attach-chip-name">${escapeHtml(attachedFile.name)}</span>` +
    `<span class="attach-chip-size">${formatSize(attachedFile.size)}</span>` +
    `<button type="button" class="attach-chip-x" title="Remove" aria-label="Remove">×</button>`;
  chip.querySelector(".attach-chip-x").addEventListener("click", () => {
    attachedFile = null;
    askFileInput.value = "";
    renderAttachChip();
  });
}

$("#attach-btn").addEventListener("click", () => askFileInput.click());
askFileInput.addEventListener("change", () => {
  attachedFile = askFileInput.files[0] || null;
  renderAttachChip();
});

$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = askInput.value.trim();
  const file = attachedFile;
  if (!question && !file) return;

  // Show the user's turn (with the attached file pill, if any).
  const userWrap = addMessage(
    "user",
    question,
    null,
    file ? { filename: file.name, size: file.size } : null
  );
  askInput.value = "";
  askInput.style.height = "auto";
  attachedFile = null;
  askFileInput.value = "";
  renderAttachChip();

  const btn = $("#ask-btn");
  btn.disabled = true;
  const typing = addTyping();

  try {
    const fd = new FormData();
    fd.append("question", question || "Summarize the attached file.");
    if (sessionId) fd.append("session_id", sessionId);
    if (file) fd.append("file", file);

    const r = await fetch("/ask", { method: "POST", body: fd });
    const data = await safeJson(r);
    typing.remove();
    if (!r.ok) throw new Error(data.detail || "Request failed");
    if (data.session_id) {
      sessionId = data.session_id;
      localStorage.setItem(SESSION_KEY, sessionId);
      setSessionLabel();
    }
    // Turn the user's file pill into a download link now that it's stored.
    if (data.attachment && userWrap) {
      const pill = userWrap.querySelector(".msg-file");
      if (pill && pill.tagName === "SPAN") {
        const a = document.createElement("a");
        a.className = "msg-file";
        a.href = `/attachments/${data.attachment.id}/download`;
        a.setAttribute("download", "");
        a.title = `Download ${data.attachment.filename}`;
        a.innerHTML = pill.innerHTML;
        pill.replaceWith(a);
      }
    }
    addMessage("assistant", data.answer || "(no answer)", data.sources);
    loadSessions(); // reflect new/updated conversation in the sidebar
  } catch (err) {
    typing.remove();
    addMessage("assistant", `**Error:** ${err.message}`);
  } finally {
    btn.disabled = false;
    askInput.focus();
  }
});

/* ---------- new chat ---------- */
$("#new-chat").addEventListener("click", () => {
  resetThread();
  loadSessions(); // clear active highlight
  askInput.focus();
});

/* ---------- restore active session on load ---------- */
async function restoreSession() {
  if (!sessionId) return;
  try {
    const r = await fetch(`/sessions/${sessionId}/messages`);
    if (!r.ok) {
      // Stale/unknown session — reset.
      localStorage.removeItem(SESSION_KEY);
      sessionId = null;
      return;
    }
    const msgs = await r.json();
    msgs.forEach((m) => addMessage(m.role, m.content));
  } catch {
    /* offline — leave empty state */
  }
 
}
 /* ---------- action buttons for code blocks and tables ---------- */
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

  // Tables → Download as CSV (opens in Excel/Sheets/Numbers)
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

// RFC 4180 CSV: quote cells containing commas, quotes, or newlines.
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
  // UTF-8 BOM (\ufeff) is the magic byte that makes Excel correctly
  // read non-ASCII characters (em dashes, accents, etc.) on Windows.
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
setSessionLabel();
restoreSession();
loadSessions();
loadDocuments();
ping();
setInterval(ping, 15000);
