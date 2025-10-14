// Very small client-side session manager using localStorage.
// Server keeps the actual thread messages; we store a list of thread IDs + titles to drive the sidebar.

const el = sel => document.querySelector(sel);
const sessionListEl = el('#sessionList');
const messagesEl = el('#messages');
const inputEl = el('#input');
const formEl = el('#chatForm');
const newChatBtn = el('#newChatBtn');
const clearBtn = el('#clearBtn');
const activeTitleEl = el('#activeTitle');

const SESS_KEY = 'reraw_sessions_v1'; // [{id,title,createdAt}...]
let sessions = loadSessions();
let activeId = null;

init();

function init(){
  renderSessionList();
  // Load current thread from server cookie (or create one) and register if unknown
  fetch('/history')
    .then(r => r.json())
    .then(data => {
      if (!data.ok) throw new Error(data.error || 'history error');
      activeId = data.threadId;
      upsertSession({ id: activeId, title: guessTitleFromHistory(data.messages) || 'New chat', createdAt: Date.now() });
      renderSessionList();
      renderMessages(data.messages);
    })
    .catch(err => {
      console.error(err);
      messagesEl.innerHTML = `<div class="empty">Could not load history. Try starting a new chat.</div>`;
    });

  newChatBtn.addEventListener('click', onNewChat);
  clearBtn.addEventListener('click', () => { messagesEl.innerHTML = `<div class="empty">Fresh chat. Ask away.</div>`; });
  formEl.addEventListener('submit', onSend);
}

async function onNewChat(){
  // ask server for a brand new thread and set cookie
  const r = await fetch('/new', { method:'POST' });
  const data = await r.json();
  if (!data.ok) { alert(data.error || 'Could not create chat'); return; }
  activeId = data.threadId;

  const newSession = { id: activeId, title: 'New chat', createdAt: Date.now() };
  upsertSession(newSession);
  renderSessionList();
  setActiveSessionUI(activeId);

  // Clear middle pane
  messagesEl.innerHTML = `<div class="empty">Fresh chat. Ask away.</div>`;
}

async function switchSession(id){
  // Calling /history?thread_id=... also sets the httpOnly cookie server-side
  const r = await fetch(`/history?thread_id=${encodeURIComponent(id)}`);
  const data = await r.json();
  if (!data.ok) { alert(data.error || 'Could not load chat'); return; }

  activeId = data.threadId;
  // Update title in case we can infer a better one
  const updatedTitle = guessTitleFromHistory(data.messages) || findSession(id)?.title || 'Chat';
  upsertSession({ id, title: updatedTitle, createdAt: findSession(id)?.createdAt || Date.now() });

  renderSessionList();
  setActiveSessionUI(id);
  renderMessages(data.messages);
}

function renderSessionList(){
  if (!sessions.length){
    sessionListEl.innerHTML = `<li class="session-item"><div class="session-title">No chats yet</div></li>`;
    return;
  }
  sessionListEl.innerHTML = sessions
    .sort((a,b)=>b.createdAt-a.createdAt)
    .map(s => {
      const active = s.id === activeId ? ' active' : '';
      const when = new Date(s.createdAt).toLocaleString();
      return `
        <li class="session-item${active}" data-id="${s.id}">
          <div>
            <div class="session-title">${escapeHtml(s.title || 'Chat')}</div>
            <div class="session-sub">${shortenId(s.id)}</div>
          </div>
          <div class="session-meta">${when}</div>
        </li>`;
    }).join('');

  // attach handlers
  sessionListEl.querySelectorAll('.session-item').forEach(li => {
    li.addEventListener('click', () => switchSession(li.dataset.id));
  });
}

function setActiveSessionUI(id){
  const s = findSession(id);
  activeTitleEl.textContent = s?.title || 'Chat';
}

function renderMessages(items){
  if (!items || !items.length){
    messagesEl.innerHTML = `<div class="empty">Fresh chat. Ask away.</div>`;
    return;
  }
  messagesEl.innerHTML = '';
  for (const m of items){
    addMessage(m.role, m.content);
  }
  scrollToBottom();
}

function addMessage(role, content){
  const isUser = role === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${isUser ? 'user' : 'assistant'}`;
  wrapper.innerHTML = `
    <div class="avatar ${isUser ? 'u' : 'a'}">${isUser ? 'U' : 'A'}</div>
    <div class="bubble">${linkify(escapeHtml(content))}</div>
  `;
  messagesEl.appendChild(wrapper);
}

async function onSend(e){
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  // show user message immediately
  addMessage('user', text);
  inputEl.value = '';
  scrollToBottom();
  formEl.classList.add('loading');

  // If this was the first user message in a "New chat", compute a better title
  const s = findSession(activeId);
  if (s && (!s.title || s.title === 'New chat')){
    s.title = titleFromPrompt(text);
    saveSessions();
    renderSessionList();
    setActiveSessionUI(activeId);
  }

  try {
    const r = await fetch('/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: [{ role:'user', content:text }] })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'chat failed');

    addMessage('assistant', data.reply || '(No reply)');
    scrollToBottom();
  } catch (err){
    console.error(err);
    addMessage('assistant', '⚠️ Error: ' + (err.message || err));
    scrollToBottom();
  } finally {
    formEl.classList.remove('loading');
  }
}

/* ---------- tiny helpers ---------- */
function loadSessions(){
  try { return JSON.parse(localStorage.getItem(SESS_KEY) || '[]'); } catch { return []; }
}
function saveSessions(){ localStorage.setItem(SESS_KEY, JSON.stringify(sessions)); }
function upsertSession(s){
  const i = sessions.findIndex(x => x.id === s.id);
  if (i >= 0) sessions[i] = { ...sessions[i], ...s };
  else sessions.push(s);
  saveSessions();
}
function findSession(id){ return sessions.find(s => s.id === id); }
function titleFromPrompt(t){ return t.slice(0, 48).trim() + (t.length > 48 ? '…' : ''); }
function guessTitleFromHistory(msgs){
  const firstUser = (msgs || []).find(m => m.role === 'user');
  return firstUser ? titleFromPrompt(firstUser.content || 'Chat') : null;
}
function shortenId(id){ return id?.slice(0,6) + '…' + id?.slice(-4); }
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function linkify(text){
  const urlRegex = /\bhttps?:\/\/[^\s]+/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}
function scrollToBottom(){ messagesEl.scrollTop = messagesEl.scrollHeight; }

