const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("userInput");
const chatForm = document.getElementById("chatForm");
const newChatBtn = document.getElementById("newChatBtn");

function addMsg(role, content){
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="bubble">
      <div class="role-tag">${role}</div>
      <div class="content">${escapeHtml(content).replace(/\n/g, "<br>")}</div>
    </div>
  `;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function escapeHtml(str=""){
  return str
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

async function loadHistory(){
  const res = await fetch("/history");
  const data = await res.json();
  messagesEl.innerHTML = "";
  if (data.ok && Array.isArray(data.messages)){
    data.messages.forEach(m => addMsg(m.role, m.content));
  }
}

async function sendMessage(text){
  addMsg("user", text);
  userInput.value = "";
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: text }] })
  });
  const data = await res.json();
  if (data.ok){
    addMsg("assistant", data.reply || "(no reply)");
  } else {
    addMsg("assistant", `Error: ${data.error || "unknown"}`);
  }
}

chatForm.addEventListener("submit", e => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  sendMessage(text);
});

newChatBtn.addEventListener("click", async () => {
  await fetch("/new", { method: "POST" });
  messagesEl.innerHTML = "";
  addMsg("assistant", "New thread started. Fire away.");
  userInput.focus();
});

loadHistory();
