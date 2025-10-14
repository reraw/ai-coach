// --- Simple Organizer Model in localStorage ---
// projects: [{id, name, folders:[{id,name,chats:[{id,title,threadId,createdAt}]}]}]
// active: { projectId, folderId, chatId }

const LS_KEY = "aiCoachOrg";

function loadOrg(){
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) {
    const seed = {
      projects: [{ id: uid(), name: "My Project", folders: [{ id: uid(), name: "General", chats: [] }] }],
      active: {}
    };
    localStorage.setItem(LS_KEY, JSON.stringify(seed));
    return seed;
  }
  try { return JSON.parse(raw); } catch { return { projects: [], active: {} }; }
}
function saveOrg(org){ localStorage.setItem(LS_KEY, JSON.stringify(org)); }
function uid(){ return Math.random().toString(36).slice(2,9); }

let org = loadOrg();

function getActiveFolder(){
  const { projectId, folderId } = org.active || {};
  const proj = org.projects.find(p => p.id === projectId);
  if (!proj) return null;
  const folder = proj.folders.find(f => f.id === folderId);
  return folder || null;
}
function setActive({projectId, folderId, chatId}){
  org.active = { projectId, folderId, chatId };
  saveOrg(org);
  renderTree();
}

async function api(path, opts){
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...opts
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Tree Rendering ---
const treeEl = document.getElementById("tree");
function renderTree(){
  treeEl.innerHTML = "";
  org.projects.forEach(project => {
    const group = document.createElement("div");
    group.className = "tree-group";

    const title = document.createElement("div");
    title.className = "tree-title";
    title.textContent = project.name;
    group.appendChild(title);

    project.folders.forEach(folder => {
      // folder row
      const fRow = document.createElement("div");
      fRow.className = "tree-item";
      fRow.innerHTML = `<span class="glyph">📁</span><span>${folder.name}</span>`;
      fRow.onclick = () => setActive({projectId: project.id, folderId: folder.id, chatId: null});
      group.appendChild(fRow);

      // chats in folder
      folder.chats.forEach(chat => {
        const cRow = document.createElement("div");
        cRow.className = "tree-item" + (org.active?.chatId === chat.id ? " active" : "");
        cRow.style.marginLeft = "24px";
        cRow.innerHTML = `<span class="glyph">💬</span><span>${chat.title || "Untitled chat"}</span>`;
        cRow.onclick = async () => {
          setActive({projectId: project.id, folderId: folder.id, chatId: chat.id});
          await api("/thread/switch", { method:"POST", body: JSON.stringify({ threadId: chat.threadId }) });
          await loadHistory();
          bannerText("Resumed chat: " + (chat.title || "Untitled chat"));
        };
        group.appendChild(cRow);
      });
    });

    treeEl.appendChild(group);
  });
}
renderTree();

// --- Buttons (sidebar) ---
document.getElementById("btnNewProject").onclick = () => {
  const name = prompt("Project name:");
  if (!name) return;
  org.projects.push({ id: uid(), name, folders: [] });
  saveOrg(org);
  renderTree();
};
document.getElementById("btnNewFolder").onclick = () => {
  if (!org.projects.length) { alert("Create a project first."); return; }
  const projectId = org.active?.projectId || org.projects[0].id;
  const name = prompt("Folder name:");
  if (!name) return;
  const proj = org.projects.find(p => p.id === projectId);
  proj.folders.push({ id: uid(), name, chats: [] });
  setActive({ projectId, folderId: proj.folders[proj.folders.length-1].id, chatId: null });
};
document.getElementById("btnNewChat").onclick = async () => {
  await createChatInActiveFolder();
};

// --- Chat area wiring (existing endpoints) ---
const historyEl = document.getElementById("history");
const formEl = document.getElementById("chatForm");
const inputEl = document.getElementById("userInput");
const clearBtn = document.getElementById("clearBtn");

function bannerText(t){
  const banner = document.querySelector(".banner");
  if (banner) banner.textContent = t;
}

async function loadHistory(){
  const res = await api("/history");
  const { messages } = res;
  historyEl.innerHTML = "";
  (messages || []).forEach(m => {
    const div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "assistant");
    div.innerHTML = `<div class="bubble">${escapeHtml(m.content)}</div>`;
    historyEl.appendChild(div);
  });
  historyEl.scrollTop = historyEl.scrollHeight;
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  // Optimistic render
  pushMessage("user", text);
  inputEl.value = "";

  // If current chat has no title yet, set one
  const folder = getActiveFolder();
  const activeChat = folder?.chats.find(c => c.id === org.active?.chatId);
  if (activeChat && !activeChat.title) {
    activeChat.title = text.slice(0, 60);
    saveOrg(org);
    renderTree();
  }

  const res = await api("/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: text }] })
  });
  pushMessage("assistant", res.reply || "(No reply)");
});

clearBtn.addEventListener("click", async () => {
  await createChatInActiveFolder();
});

async function createChatInActiveFolder(){
  // ensure a folder is selected
  let folder = getActiveFolder();
  if (!folder) {
    if (!org.projects.length) {
      org.projects.push({ id: uid(), name: "My Project", folders: [] });
    }
    const proj = org.projects[0];
    const f = { id: uid(), name: "General", chats: [] };
    proj.folders.push(f);
    setActive({ projectId: proj.id, folderId: f.id, chatId: null });
    folder = f;
  }

  // create server thread
  const res = await api("/new", { method:"POST" });
  const threadId = res.threadId;

  // record chat object
  const chat = { id: uid(), title: "", threadId, createdAt: Date.now() };
  folder.chats.unshift(chat);
  setActive({ projectId: org.active.projectId, folderId: org.active.folderId, chatId: chat.id });

  // clear UI / load empty history
  historyEl.innerHTML = "";
  bannerText("Fresh chat. Ask away.");
  await loadHistory();
}

// Helpers
function pushMessage(role, text){
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "assistant");
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  historyEl.appendChild(div);
  historyEl.scrollTop = historyEl.scrollHeight;
}
function escapeHtml(str){
  return (str || "").replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[s]));
}

// Initial load
loadHistory().catch(()=>{});
