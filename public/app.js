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

function saveState(){
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state = JSON.parse(raw);
  }catch(e){
    console.warn("Failed to parse saved state; using defaults.");
  }
}
function uid(prefix="id"){
  return `${prefix}_${Math.random().toString(36).slice(2,9)}`;
}
function firstLine(text){
  const t = (text || "").trim();
  const line = t.split("\n").find(Boolean) || "Untitled chat";
  return line.length > 48 ? line.slice(0,45) + "…" : line;
}

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

function maybeShowFreshBanner(){
  const hasMessages = messagesEl.childElementCount > 0;
  freshBanner.classList.toggle("hidden", hasMessages);
}
function hideFreshBannerIfNecessary(){
  freshBanner.classList.add("hidden");
}

function formatDate(ts){
  try{
    return new Date(ts).toLocaleDateString();
  }catch(_){ return ""; }
}

/* ------------ Sidebar rendering ------------ */

function renderSidebar(){
  renderFolders();
  renderUncategorizedChats();
  markActive(threadId);
}

function renderFolders(){
  const filter = (chatSearchEl.value || "").toLowerCase().trim();
  folderListEl.innerHTML = "";

  const folders = Object.values(state.folders);
  folders.sort((a,b) => a.name.localeCompare(b.name));

  folders.forEach(f => {
    const li = document.createElement("li");
    li.className = "folder";
    li.dataset.fid = f.id;

    // row
    const chevron = document.createElement("span");
    chevron.className = "icon";
    chevron.textContent = f.open ? "▾" : "▸";
    chevron.title = f.open ? "Collapse" : "Expand";
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      f.open = !f.open;
      saveState();
      renderSidebar();
    });

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📁";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = f.name;

    const counts = document.createElement("div");
    counts.className = "counts";
    counts.textContent = `${f.chats.length}`;

    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nn = prompt("Rename folder:", f.name);
      if (nn && nn.trim()){
        f.name = nn.trim();
        saveState(); renderSidebar();
      }
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm("Delete this folder? Chats inside will be moved to Uncategorized.")) return;
      // move chats back
      f.chats.forEach(tid => {
        if (!state.uncategorized.includes(tid)) state.uncategorized.unshift(tid);
      });
      delete state.folders[f.id];
      saveState(); renderSidebar();
    });
    rowActions.append(renameBtn, deleteBtn);

    li.append(chevron, icon, title, counts, rowActions);

    // nested chats
    if (f.open){
      const ul = document.createElement("ul");
      ul.className = "chat-list";
      f.chats.forEach(tid => {
        const t = state.threads[tid];
        if (!t) return;

        if (filter && !t.title.toLowerCase().includes(filter)) return;

        const ci = chatListItem(t, { withinFolderId: f.id });
        ul.appendChild(ci);
      });
      folderListEl.appendChild(li);
      folderListEl.appendChild(ul);
    } else {
      folderListEl.appendChild(li);
    }
  });
}

function chatListItem(t, opts={}){
  const li = document.createElement("li");
  li.className = "chat-item";
  li.dataset.tid = t.id;

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "💬";

  const meta = document.createElement("div");
  meta.className = "meta";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;

  const date = document.createElement("div");
  date.className = "date";
  date.textContent = formatDate(t.createdAt);

  meta.append(title, date);

  const rowActions = document.createElement("div");
  rowActions.className = "row-actions";
  const moveBtn = document.createElement("button");
  moveBtn.textContent = "Move";
  moveBtn.title = "Move to folder";
  moveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    moveChatPrompt(t.id);
  });

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.title = "Remove from sidebar list";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this chat from your sidebar? (This does NOT delete the OpenAI thread.)")) return;
    removeChatFromLists(t.id);
    if (threadId === t.id){
      // If you deleted the active one, create a fresh new chat view
      await startNewThread();
    }
  });

  rowActions.append(moveBtn, delBtn);

  li.append(icon, meta, rowActions);

  li.addEventListener("click", () => switchThread(t.id));
  return li;
}

function renderUncategorizedChats(){
  const filter = (chatSearchEl.value || "").toLowerCase().trim();
  chatListEl.innerHTML = "";
  state.uncategorized.forEach(tid => {
    const t = state.threads[tid];
    if (!t) return;
    if (filter && !t.title.toLowerCase().includes(filter)) return;
    chatListEl.appendChild(chatListItem(t));
  });
}

function markActive(tid){
  [...document.querySelectorAll(".chat-item")].forEach(el => {
    el.classList.toggle("active", el.dataset.tid === tid);
  });
}

/* ------------ Folder/Chat actions ------------ */

function addFolder(){
  const name = prompt("Folder name:");
  if (!name || !name.trim()) return;
  const id = uid("folder");
  state.folders[id] = { id, name: name.trim(), open: true, chats: [] };
  saveState(); renderSidebar();
}

function removeChatFromLists(tid){
  state.uncategorized = state.uncategorized.filter(x => x !== tid);
  for (const f of Object.values(state.folders)){
    f.chats = f.chats.filter(x => x !== tid);
  }
  delete state.threads[tid]; // remove metadata entirely
  saveState(); renderSidebar();
}

function moveChatPrompt(tid){
  const folderIds = Object.keys(state.folders);
  const choices = ["Uncategorized", ...folderIds.map(fid => state.folders[fid].name)];
  const pick = prompt(`Move chat to:\n${choices.map((c,i)=> `${i}. ${c}`).join("\n")}\n\nEnter a number:`, "0");
  const idx = Number(pick);
  if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) return;

  // remove from everywhere first
  state.uncategorized = state.uncategorized.filter(x => x !== tid);
  Object.values(state.folders).forEach(f => f.chats = f.chats.filter(x => x !== tid));

  if (idx === 0){
    state.uncategorized.unshift(tid);
  } else {
    const targetFolder = state.folders[folderIds[idx - 1]];
    if (targetFolder) targetFolder.chats.unshift(tid);
  }
  saveState(); renderSidebar();
}

/* ------------ API ------------ */

async function fetchHistory(targetThreadId=null){
  const url = targetThreadId ? `/history?thread_id=${encodeURIComponent(targetThreadId)}` : "/history";
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  state.lastActiveThreadId = threadId;
  saveState();

  clearMessages();

  const msgs = j.messages || [];
  if (msgs.length === 0){
    maybeShowFreshBanner();
  } else {
    msgs.forEach(m => addMsg(m.role, m.content));
  }

  // Ensure this thread is indexed in UI state
  const firstUser = msgs.find(m => m.role === "user");
  const titleSeed = firstUser?.content || msgs[0]?.content || "New chat";
  const title = firstLine(titleSeed);

  if (!state.threads[threadId]){
    state.threads[threadId] = { id: threadId, title, createdAt: Date.now() };
    // Default to uncategorized on first sight
    if (!state.uncategorized.includes(threadId)) state.uncategorized.unshift(threadId);
    saveState();
  } else {
    // If it had "New chat" update title if we see a better one
    if (state.threads[threadId].title === "New chat" && title !== "New chat"){
      state.threads[threadId].title = title;
      saveState();
    }
  }

  renderSidebar();
}

async function switchThread(tid){
  if (!tid) return;
  await fetchHistory(tid); // server sets cookie and returns that thread
}

async function startNewThread(){
  const r = await fetch("/new", { method: "POST" });
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  state.lastActiveThreadId = threadId;

  // index new chat
  state.threads[threadId] = { id: threadId, title: "New chat", createdAt: Date.now() };
  state.uncategorized.unshift(threadId);
  saveState();

  clearMessages();
  maybeShowFreshBanner();
  renderSidebar();
}

async function sendChat(text){
  addMsg("user", text);

  // Update title when first user message comes in
  const t = state.threads[threadId];
  if (t && (t.title === "New chat" || !t.title)){
    t.title = firstLine(text);
    saveState();
    renderSidebar();
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

collapseBtn.addEventListener("click", () => {
  sidebarEl.classList.toggle("collapsed");
});

chatSearchEl.addEventListener("input", () => {
  renderSidebar();
});

document.getElementById("newFolderBtn").addEventListener("click", addFolder);

/* ------------ Init ------------ */
loadState();
fetchHistory(state.lastActiveThreadId /* may be null, server will make new */);
