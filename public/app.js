const chatListEl = document.getElementById("chatList");
const messagesEl = document.getElementById("messages");
const composerEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const newChatBtn = document.getElementById("newChatBtn");
const refreshBtn = document.getElementById("refreshBtn");
const freshBanner = document.getElementById("freshBanner");

let threadId = null;
let history = []; // simple in-memory index for left nav titles

/* ------------ UI helpers ------------ */

function addMsg(role, text){
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  hideFreshBannerIfNecessary();
}

function clearMessages(){
  messagesEl.innerHTML = "";
  maybeShowFreshBanner();
}

function firstLine(text){
  const t = (text || "").trim();
  const line = t.split("\n").find(Boolean) || "Untitled chat";
  return line.length > 48 ? line.slice(0,45) + "…" : line;
}

function upsertChatListItem(tid, title){
  const existing = chatListEl.querySelector(`[data-tid="${tid}"]`);
  const html = `
    <div class="title">${title}</div>
    <div class="date">${new Date().toLocaleDateString()}</div>
  `;
  if (existing){
    existing.innerHTML = html;
  } else {
    const li = document.createElement("li");
    li.className = "chat-item";
    li.dataset.tid = tid;
    li.innerHTML = html;
    li.addEventListener("click", () => switchThread(tid));
    chatListEl.prepend(li);
  }
  markActive(tid);
}

function markActive(tid){
  [...chatListEl.querySelectorAll(".chat-item")].forEach(el => {
    el.classList.toggle("active", el.dataset.tid === tid);
  });
}

function maybeShowFreshBanner(){
  // Show banner if thread exists but there are no messages
  const hasMessages = messagesEl.childElementCount > 0;
  freshBanner.classList.toggle("hidden", hasMessages);
}
function hideFreshBannerIfNecessary(){
  freshBanner.classList.add("hidden");
}

/* ------------ API ------------ */

async function fetchHistory(){
  const r = await fetch("/history");
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  clearMessages();

  const msgs = j.messages || [];
  if (msgs.length === 0){
    maybeShowFreshBanner();
  } else {
    msgs.forEach(m => addMsg(m.role, m.content));
  }

  // Seed chat list if new
  if (!history.find(h => h.id === threadId)){
    const title = msgs[0]?.content ? firstLine(msgs[0].content) : "New chat";
    history.unshift({ id: threadId, title });
    upsertChatListItem(threadId, title);
  } else {
    markActive(threadId);
  }
}

async function switchThread(tid){
  // Just swap the cookie by calling /new if different? Better approach:
  // We can store tid in cookie only server-side, so here we’ll simulate:
  // Call /new to open a fresh thread unless tid is current; we won’t load arbitrary threads.
  // For now, minimal behavior: clicking the active item does nothing.
  if (tid === threadId) return;

  // In this simple version, we can’t randomly jump to any past server thread without server support.
  // So we keep the sidebar as a visual catalog and start a new one if clicked a non-active item.
  await startNewThread();
}

async function startNewThread(){
  const r = await fetch("/new", { method: "POST" });
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  clearMessages();
  maybeShowFreshBanner();

  const title = "New chat";
  history.unshift({ id: threadId, title });
  upsertChatListItem(threadId, title);
}

async function sendChat(text){
  addMsg("user", text);

  // Update list item title with first line of the first user message
  const found = history.find(h => h.id === threadId);
  if (found && found.title === "New chat"){
    found.title = firstLine(text);
    upsertChatListItem(threadId, found.title);
  }

  const r = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ messages: [{ role:"user", content: text }] })
  });

  const j = await r.json();
  if (!j.ok){
    addMsg("assistant", `Error: ${j.error || "Something went wrong."}`);
    return;
  }
  addMsg("assistant", j.reply);
}

/* ------------ Wire up ------------ */

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendChat(text);
});

newChatBtn.addEventListener("click", () => startNewThread());
refreshBtn.addEventListener("click", () => fetchHistory());

/* init */
fetchHistory();
