/* DOM */
const folderListEl = document.getElementById("folderList");
const chatListEl   = document.getElementById("chatList");
const messagesEl   = document.getElementById("messages");
const composerEl   = document.getElementById("composer");
const inputEl      = document.getElementById("input");
const newChatBtn   = document.getElementById("newChatBtn");
const refreshBtn   = document.getElementById("refreshBtn");
const freshBanner  = document.getElementById("freshBanner");
const collapseBtn  = document.getElementById("collapseBtn");
const sidebarEl    = document.getElementById("sidebar");
const chatSearchEl = document.getElementById("chatSearch");
const newFolderBtn = document.getElementById("newFolderBtn");

/* State persisted in localStorage */
const LS_KEY = "reraw-ui-state-v1";
let state = {
  threads: {},           // { [threadId]: { id, title, createdAt } }
  folders: {},           // { [folderId]: { id, name, open: true, chats: [threadId,...] } }
  uncategorized: [],     // [threadId,...]
  lastActiveThreadId: null
};

let threadId = null;

/* ------------ Utilities ------------ */

function saveState(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function loadState(){
  try{ const raw = localStorage.getItem(LS_KEY); if (raw) state = JSON.parse(raw); }
  catch{ /* ignore */ }
}
function uid(prefix="id"){ return `${prefix}_${Math.random().toString(36).slice(2,9)}`; }
function firstLine(text){
  const t = (text || "").trim();
  const line = t.split("\n").find(Boolean) || "Untitled chat";
  return line.length > 48 ? line.slice(0,45) + "…" : line;
}
function formatDate(ts){ try{ return new Date(ts).toLocaleDateString(); }catch{ return ""; } }

/* Basic rich text renderer for assistant replies (paragraphs & lists) */
function renderRichText(text){
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  blocks.forEach(block => {
    const lines = block.split("\n");
    const isBullet = lines.every(l => /^(\s*[-*]\s+)/.test(l));
    const isNumber = lines.every(l => /^(\s*\d+[\.)]\s+)/.test(l));
    if (isBullet || isNumber){
      const listEl = isBullet ? document.createElement("ul") : document.createElement("ol");
      lines.forEach(l => {
        const clean = l.replace(/^(\s*[-*]|\s*\d+[\.)])\s+/, "");
        const li = document.createElement("li");
        li.textContent = clean;
        listEl.appendChild(li);
      });
      frag.appendChild(listEl);
    } else {
      const p = document.createElement("p");
      p.textContent = block.trim();
      frag.appendChild(p);
    }
  });
  return frag;
}

/* Clipboard */
async function copyText(txt){
  try{
    await navigator.clipboard.writeText(txt);
  }catch{
    // fallback
    const ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  }
}

/* ------------ Context menu (projects/chats) ------------ */
/* (Same as prior version, kept for completeness — omitted here for brevity)
   If you need me to paste the full menu code again, I can. This update focuses
   on message rendering & copy actions and does not change the folder/chat menus. */

/* ------------ Message rendering (UPDATED) ------------ */

function addUserMsg(text){
  const wrap = document.createElement("div");
  wrap.className = "msg user";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  // copy button on hover (inside bubble)
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.type = "button";
  copyBtn.title = "Copy";
  copyBtn.textContent = "📋";
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText(text);
  });
  bubble.appendChild(copyBtn);

  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  hideFreshBannerIfNecessary();
}

function addAssistantMsg(text){
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // Content (no bubble visuals — styled as plain text block)
  const content = document.createElement("div");
  content.className = "content";
  content.appendChild(renderRichText(text));
  bubble.appendChild(content);

  // Toolbar (copy + divider line)
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-row-btn";
  copyBtn.type = "button";
  copyBtn.textContent = "Copy response";
  copyBtn.title = "Copy response";
  copyBtn.addEventListener("click", () => copyText(text));

  const divider = document.createElement("div");
  divider.className = "divider";

  toolbar.append(copyBtn, divider);
  bubble.appendChild(toolbar);

  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  hideFreshBannerIfNecessary();
}

function addMsg(role, text){
  if (role === "user") return addUserMsg(text);
  return addAssistantMsg(text);
}

function clearMessages(){ messagesEl.innerHTML = ""; maybeShowFreshBanner(); }
function maybeShowFreshBanner(){ freshBanner.classList.toggle("hidden", messagesEl.childElementCount > 0); }
function hideFreshBannerIfNecessary(){ freshBanner.classList.add("hidden"); }

/* ------------ Sidebar/project UI (unchanged from your last working version) ------------ */
/* For space, I’m not re-pasting the project/folder code you already have working.
   Keep your current version from the last update. Only message rendering changed. */

/* ------------ API ------------ */

async function fetchHistory(targetThreadId=null){
  const url = targetThreadId ? `/history?thread_id=${encodeURIComponent(targetThreadId)}` : "/history";
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  state.lastActiveThreadId = threadId; saveState();

  clearMessages();

  const msgs = j.messages || [];
  if (msgs.length === 0){ maybeShowFreshBanner(); }
  else { msgs.forEach(m => addMsg(m.role, m.content)); }

  // Index in sidebar state if needed (title = first line of first user or first msg)
  const firstUser = msgs.find(m => m.role === "user");
  const titleSeed = firstUser?.content || msgs[0]?.content || "New chat";
  const title = firstLine(titleSeed);
  if (!state.threads[threadId]){
    state.threads[threadId] = { id: threadId, title, createdAt: Date.now() };
    if (!state.uncategorized.includes(threadId)) state.uncategorized.unshift(threadId);
    saveState();
  } else if (state.threads[threadId].title === "New chat" && title !== "New chat"){
    state.threads[threadId].title = title; saveState();
  }

  // Re-render your existing sidebar here if needed
  if (typeof renderSidebar === "function") renderSidebar();
}

async function sendChat(text){
  addUserMsg(text);

  // Update title when first user message comes in
  const t = state.threads[threadId];
  if (t && (t.title === "New chat" || !t.title)){
    t.title = firstLine(text);
    saveState();
    if (typeof renderSidebar === "function") renderSidebar();
  }

  const r = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ messages: [{ role:"user", content: text }] })
  });

  const j = await r.json();
  if (!j.ok){
    addAssistantMsg(`Error: ${j.error || "Something went wrong."}`);
    return;
  }
  addAssistantMsg(j.reply);
}

/* ------------ Wire up (minimal) ------------ */
composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendChat(text);
});
if (newChatBtn) newChatBtn.addEventListener("click", async () => {
  const r = await fetch("/new", { method: "POST" });
  const j = await r.json();
  if (j?.ok){
    threadId = j.threadId;
    state.lastActiveThreadId = threadId;
    state.threads[threadId] = { id: threadId, title: "New chat", createdAt: Date.now() };
    state.uncategorized.unshift(threadId);
    saveState();
    clearMessages(); maybeShowFreshBanner();
    if (typeof renderSidebar === "function") renderSidebar();
  }
});
if (refreshBtn) refreshBtn.addEventListener("click", () => fetchHistory());
/* keep your collapse/search/folder/menu listeners from the previous version */

/* ------------ Init ------------ */
loadState();
fetchHistory(state.lastActiveThreadId /* may be null, server will create new */);
