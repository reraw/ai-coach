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
function formatDate(ts){
  try{ return new Date(ts).toLocaleDateString(); }catch(_){ return ""; }
}

/* ------------ Context menu ------------ */

let currentMenu = null;

function closeMenu(){
  if (currentMenu?.el){
    currentMenu.el.remove();
    currentMenu = null;
  }
}

function showMenu(items, anchorRect){
  closeMenu();
  if (!items || !items.length) return;

  const menu = document.createElement("div");
  menu.className = "context-menu";

  items.forEach((it) => {
    if (it === "sep"){
      const s = document.createElement("div");
      s.className = "sep";
      menu.appendChild(s);
      return;
    }
    const row = document.createElement("div");
    row.className = "item";
    row.textContent = it.label;
    row.addEventListener("click", () => {
      it.onClick?.();
      // Do not close here if handler opens a follow-up menu; handlers can call closeMenu themselves.
      if (!it.keepOpen) closeMenu();
    });
    menu.appendChild(row);
  });

  document.body.appendChild(menu);

  // position near anchor
  const margin = 6;
  let x = anchorRect.left;
  let y = anchorRect.bottom + margin;

  const vw = window.innerWidth, vh = window.innerHeight;
  const { width:mw, height:mh } = menu.getBoundingClientRect();

  if (x + mw > vw - margin) x = vw - mw - margin;
  if (y + mh > vh - margin) y = anchorRect.top - mh - margin;

  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  currentMenu = { el: menu };

  // close on outside / escape / scroll (attach in next frame to avoid immediate close)
  requestAnimationFrame(() => {
    const onDocClick = (e) => {
      if (!currentMenu?.el) return;
      if (!currentMenu.el.contains(e.target)) closeMenu();
      document.removeEventListener("click", onDocClick, true);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") closeMenu();
      document.removeEventListener("keydown", onKeyDown, true);
    };
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", closeMenu, { once:true });
    window.addEventListener("resize", closeMenu, { once:true });
  });
}

/* Follow-up menu for Move to project… */
function showMoveMenu(tid, anchorRect){
  // Build items dynamically each time
  const folderIds = Object.keys(state.folders).sort((a,b) =>
    state.folders[a].name.localeCompare(state.folders[b].name)
  );

  const items = [];

  folderIds.forEach(fid => {
    const f = state.folders[fid];
    items.push({
      label: `Move to “${f.name}”`,
      onClick: () => {
        moveChatToFolder(tid, fid);
        renderSidebar();
      }
    });
  });

  if (folderIds.length) items.push("sep");

  items.push({
    label: "New project…",
    onClick: () => {
      const name = prompt("Project name:");
      if (!name || !name.trim()) return;
      const id = uid("folder");
      state.folders[id] = { id, name: name.trim(), open: true, chats: [] };
      moveChatToFolder(tid, id);
      saveState(); renderSidebar();
    }
  });

  // Keep the original menu open until the follow-up appears, then replace it.
  closeMenu();
  showMenu(items, anchorRect);
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

/* ------------ Sidebar rendering ------------ */

function renderSidebar(){
  renderFolders();
  renderUncategorizedChats();
  markActive(threadId);
}

function renderFolders(){
  const filter = (chatSearchEl.value || "").toLowerCase().trim();
  folderListEl.innerHTML = "";

  const folders = Object.values(state.folders).sort((a,b) => a.name.localeCompare(b.name));

  folders.forEach(f => {
    const li = document.createElement("li");
    li.className = "folder";
    li.dataset.fid = f.id;

    // Clicking the row toggles open/closed (like ChatGPT)
    li.addEventListener("click", () => {
      f.open = !f.open; saveState(); renderSidebar();
    });

    const chevron = document.createElement("span");
    chevron.className = "icon";
    chevron.textContent = f.open ? "▾" : "▸";
    chevron.title = f.open ? "Collapse" : "Expand";
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      f.open = !f.open; saveState(); renderSidebar();
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

    const dots = document.createElement("button");
    dots.className = "dots-btn";
    dots.type = "button";
    dots.textContent = "⋯";
    dots.title = "More";
    dots.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = dots.getBoundingClientRect();
      showMenu([
        { label: "Rename project", onClick: () => renameFolder(f.id) },
        { label: "New chat in this project", onClick: () => startNewThreadInFolder(f.id) },
        "sep",
        { label: "Delete project", onClick: () => deleteFolder(f.id) },
      ], rect);
    });

    li.append(chevron, icon, title, counts, dots);
    folderListEl.appendChild(li);

    if (f.open){
      const ul = document.createElement("ul");
      ul.className = "chat-list";
      f.chats.forEach(tid => {
        const t = state.threads[tid];
        if (!t) return;
        if (filter && !t.title.toLowerCase().includes(filter)) return;
        ul.appendChild(chatListItem(t, { withinFolderId: f.id }));
      });
      folderListEl.appendChild(ul);
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

  const dots = document.createElement("button");
  dots.className = "dots-btn";
  dots.type = "button";
  dots.textContent = "⋯";
  dots.title = "More";
  dots.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = dots.getBoundingClientRect();
    showMenu([
      { label: "Rename", onClick: () => renameChat(t.id) },
      { label: "Move to project…", onClick: () => showMoveMenu(t.id, rect), keepOpen: true },
      "sep",
      { label: "Delete", onClick: async () => {
          if (!confirm("Delete this chat from your sidebar? (Does NOT delete the OpenAI thread.)")) return;
          await deleteChatLocal(t.id);
        }
      },
    ], rect);
  });

  li.append(icon, meta, dots);
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
  const name = prompt("Project name:");
  if (!name || !name.trim()) return;
  const id = uid("folder");
  state.folders[id] = { id, name: name.trim(), open: true, chats: [] };
  saveState(); renderSidebar();
}
function renameFolder(fid){
  const f = state.folders[fid]; if (!f) return;
  const nn = prompt("Rename project:", f.name);
  if (nn && nn.trim()){ f.name = nn.trim(); saveState(); renderSidebar(); }
}
function deleteFolder(fid){
  const f = state.folders[fid]; if (!f) return;
  if (!confirm("Delete this project? Chats inside will move to Uncategorized.")) return;
  f.chats.forEach(tid => { if (!state.uncategorized.includes(tid)) state.uncategorized.unshift(tid); });
  delete state.folders[fid];
  saveState(); renderSidebar();
}

function renameChat(tid){
  const t = state.threads[tid]; if (!t) return;
  const nn = prompt("Rename chat:", t.title);
  if (nn && nn.trim()){
    t.title = nn.trim();
    saveState(); renderSidebar();
  }
}

function moveChatToFolder(tid, fid){
  // remove everywhere
  state.uncategorized = state.uncategorized.filter(x => x !== tid);
  Object.values(state.folders).forEach(f => f.chats = f.chats.filter(x => x !== tid));

  const target = state.folders[fid];
  if (target){
    target.chats.unshift(tid);
    target.open = true;
  } else {
    // fallback to uncategorized
    state.uncategorized.unshift(tid);
  }
  saveState(); renderSidebar();
}

async function deleteChatLocal(tid){
  state.uncategorized = state.uncategorized.filter(x => x !== tid);
  for (const f of Object.values(state.folders)){
    f.chats = f.chats.filter(x => x !== tid);
  }
  delete state.threads[tid];
  saveState(); renderSidebar();

  if (threadId === tid){
    await startNewThread();
  }
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
    if (!state.uncategorized.includes(threadId)) state.uncategorized.unshift(threadId);
    saveState();
  } else {
    if (state.threads[threadId].title === "New chat" && title !== "New chat"){
      state.threads[threadId].title = title;
      saveState();
    }
  }

  renderSidebar();
}

async function switchThread(tid){
  if (!tid) return;
  await fetchHistory(tid);
}

async function startNewThread(){
  const r = await fetch("/new", { method: "POST" });
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  state.lastActiveThreadId = threadId;

  state.threads[threadId] = { id: threadId, title: "New chat", createdAt: Date.now() };
  state.uncategorized.unshift(threadId);
  saveState();

  clearMessages();
  maybeShowFreshBanner();
  renderSidebar();
}

async function startNewThreadInFolder(fid){
  // Create a new thread server-side
  const r = await fetch("/new", { method: "POST" });
  const j = await r.json();
  if (!j.ok) return;

  threadId = j.threadId;
  state.lastActiveThreadId = threadId;

  // index and place it in folder
  const tMeta = { id: threadId, title: "New chat", createdAt: Date.now() };
  state.threads[threadId] = tMeta;

  // remove from uncategorized if it got added elsewhere
  state.uncategorized = state.uncategorized.filter(x => x !== threadId);

  const f = state.folders[fid];
  if (f){
    f.chats.unshift(threadId);
    f.open = true;
  } else {
    state.uncategorized.unshift(threadId);
  }

  saveState();

  // Open clean panel
  clearMessages();
  maybeShowFreshBanner();
  renderSidebar();
}

async function sendChat(text){
  addMsg("user", text);

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
if (collapseBtn){
  collapseBtn.addEventListener("click", () => {
    sidebarEl.classList.toggle("collapsed");
    closeMenu();
  });
}
chatSearchEl.addEventListener("input", () => {
  renderSidebar();
  closeMenu();
});
if (newFolderBtn){
  newFolderBtn.addEventListener("click", addFolder);
}

/* ------------ Init ------------ */
loadState();
fetchHistory(state.lastActiveThreadId /* may be null, server will make new */);
