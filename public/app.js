// Minimal client-side state: stored in localStorage
// - projects: [{id, name}]
// - chats: [{threadId, title, projectId|null, createdAt}]
// - currentThreadId

const els = {
  projectList: document.getElementById("projectList"),
  unsortedList: document.getElementById("unsortedList"),
  btnNewChat: document.getElementById("btnNewChat"),
  btnNewProject: document.getElementById("btnNewProject"),
  searchInput: document.getElementById("searchInput"),
  messages: document.getElementById("messages"),
  chatScroll: document.getElementById("chatScroll"),
  emptyState: document.getElementById("emptyState"),
  form: document.getElementById("composerForm"),
  input: document.getElementById("composerInput"),
  currentThreadLabel: document.getElementById("currentThreadLabel"),
};

const store = {
  load() {
    try {
      return {
        projects: JSON.parse(localStorage.getItem("projects") || "[]"),
        chats: JSON.parse(localStorage.getItem("chats") || "[]"),
        currentThreadId: localStorage.getItem("currentThreadId") || null,
      };
    } catch {
      return { projects: [], chats: [], currentThreadId: null };
    }
  },
  save(state) {
    localStorage.setItem("projects", JSON.stringify(state.projects));
    localStorage.setItem("chats", JSON.stringify(state.chats));
    if (state.currentThreadId) localStorage.setItem("currentThreadId", state.currentThreadId);
    else localStorage.removeItem("currentThreadId");
  },
};

let state = store.load();

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// --- UI RENDERING ---

function renderSidebar() {
  const q = (els.searchInput.value || "").toLowerCase();

  // projects
  els.projectList.innerHTML = "";
  state.projects.forEach((p) => {
    const li = document.createElement("li");
    li.className = "item";

    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = p.name;

    row.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "actions";

    // rename project
    const renameBtn = iconButton("✏️", "Rename project", () => {
      const name = prompt("Project name:", p.name);
      if (name && name.trim()) {
        p.name = name.trim();
        store.save(state);
        renderSidebar();
      }
    });

    // delete project
    const delBtn = iconButton("🗑️", "Delete project", () => {
      if (!confirm("Delete project? Chats will become unsorted.")) return;
      // reassign chats to unsorted
      state.chats.forEach((c) => {
        if (c.projectId === p.id) c.projectId = null;
      });
      // remove project
      state.projects = state.projects.filter((x) => x.id !== p.id);
      store.save(state);
      renderSidebar();
    });

    actions.append(renameBtn, delBtn);
    row.appendChild(actions);
    li.appendChild(row);

    // child chats for this project
    const ul = document.createElement("ul");
    ul.className = "list";
    const chatsInProject = state.chats
      .filter((c) => c.projectId === p.id)
      .filter((c) => c.title.toLowerCase().includes(q));

    chatsInProject.forEach((c) => ul.appendChild(chatItem(c)));
    li.appendChild(ul);
    els.projectList.appendChild(li);
  });

  // unsorted
  els.unsortedList.innerHTML = "";
  const unsorted = state.chats
    .filter((c) => !c.projectId)
    .filter((c) => c.title.toLowerCase().includes(q));
  unsorted.forEach((c) => els.unsortedList.appendChild(chatItem(c)));
}

function iconButton(symbol, title, onClick) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.title = title;
  b.textContent = symbol;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function chatItem(c) {
  const li = document.createElement("li");
  li.className = "item" + (state.currentThreadId === c.threadId ? " active" : "");

  const row = document.createElement("div");
  row.className = "row";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = c.title || "(Untitled)";
  row.appendChild(label);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = new Date(c.createdAt).toLocaleDateString();
  row.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  // move to project
  const moveBtn = iconButton("📁", "Move to project", () => {
    if (!state.projects.length) {
      alert("No projects yet. Create one first.");
      return;
    }
    const names = state.projects.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    const pick = prompt(`Move to which project?\n\n${names}\n\nEnter number, or 0 for Unsorted:`, "1");
    if (pick === null) return;
    const idx = Number(pick) - 1;
    if (Number(pick) === 0) {
      c.projectId = null;
    } else if (!Number.isNaN(idx) && state.projects[idx]) {
      c.projectId = state.projects[idx].id;
    } else {
      alert("Not a valid choice.");
      return;
    }
    store.save(state);
    renderSidebar();
  });

  // rename chat
  const renameBtn = iconButton("✏️", "Rename chat", () => {
    const name = prompt("Chat title:", c.title || "");
    if (name && name.trim()) {
      c.title = name.trim();
      store.save(state);
      renderSidebar();
    }
  });

  // delete chat
  const delBtn = iconButton("🗑️", "Delete chat", async () => {
    if (!confirm("Delete this chat? This cannot be undone.")) return;
    try {
      await fetch(`/thread?threadId=${encodeURIComponent(c.threadId)}`, { method: "DELETE" });
    } catch {}
    state.chats = state.chats.filter((x) => x.threadId !== c.threadId);
    if (state.currentThreadId === c.threadId) {
      state.currentThreadId = null;
      clearMessages();
      setHeaderThread(null);
    }
    store.save(state);
    renderSidebar();
  });

  actions.append(moveBtn, renameBtn, delBtn);
  row.appendChild(actions);

  li.appendChild(row);
  li.addEventListener("click", () => switchChat(c.threadId));
  return li;
}

function clearMessages() {
  els.messages.innerHTML = "";
  els.emptyState.style.display = "block";
}

function pushBubble(role, text) {
  els.emptyState.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = "bubble " + (role === "user" ? "user" : "assistant");

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "You" : "RERAW AI Coach";

  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.textContent = text;

  wrap.appendChild(roleEl);
  wrap.appendChild(textEl);
  els.messages.appendChild(wrap);

  // scroll
  setTimeout(() => { els.chatScroll.scrollTop = els.chatScroll.scrollHeight; }, 0);
}

function setHeaderThread(threadId) {
  els.currentThreadLabel.textContent = threadId ? `Thread: ${threadId}` : "";
}

// --- data ops ---

async function loadHistory(threadId) {
  const resp = await fetch(`/history?threadId=${encodeURIComponent(threadId)}`);
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || "history failed");
  clearMessages();
  for (const m of json.messages) {
    pushBubble(m.role, m.content);
  }
}

async function switchChat(threadId) {
  state.currentThreadId = threadId;
  store.save(state);
  setHeaderThread(threadId);
  renderSidebar();
  // set cookie on server for this thread
  await fetch("/thread/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  await loadHistory(threadId);
}

async function newChat() {
  const resp = await fetch("/new", { method: "POST" });
  const json = await resp.json();
  if (!json.ok) {
    alert(json.error || "Failed creating chat");
    return;
  }
  const threadId = json.threadId;
  const chat = { threadId, title: "New chat", projectId: null, createdAt: Date.now() };
  state.chats.unshift(chat);
  state.currentThreadId = threadId;
  store.save(state);
  setHeaderThread(threadId);
  renderSidebar();
  clearMessages();
}

// send message
async function sendMessage(text) {
  if (!state.currentThreadId) {
    await newChat();
  }
  pushBubble("user", text);
  els.input.value = "";
  els.input.style.height = "auto";

  const resp = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: state.currentThreadId,
      messages: [{ role: "user", content: text }],
    }),
  });
  const json = await resp.json();
  if (!json.ok) {
    pushBubble("assistant", `⚠️ ${json.error || "Something went wrong."}`);
    return;
  }
  // update label if it's still Untitled/New
  const chat = state.chats.find((c) => c.threadId === state.currentThreadId);
  if (chat && (!chat.title || chat.title === "New chat")) {
    const first = (text || "").trim().slice(0, 60);
    chat.title = first || "New chat";
    store.save(state);
    renderSidebar();
  }
  pushBubble("assistant", json.reply || "(No reply)");
}

// --- events ---

els.btnNewChat.addEventListener("click", newChat);
els.btnNewProject.addEventListener("click", () => {
  const name = prompt("Project name:");
  if (!name || !name.trim()) return;
  state.projects.unshift({ id: uid(), name: name.trim() });
  store.save(state);
  renderSidebar();
});

els.searchInput.addEventListener("input", renderSidebar);

// autoresize textarea
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(160, els.input.scrollHeight) + "px";
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  await sendMessage(text);
});

// boot
(async function init() {
  renderSidebar();
  if (state.currentThreadId) {
    setHeaderThread(state.currentThreadId);
    try { await switchChat(state.currentThreadId); } catch {}
  } else {
    clearMessages();
  }
})();
