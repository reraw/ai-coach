// index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// --- OpenAI setup ---
if (!process.env.OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");
if (!process.env.ASSISTANT_ID) console.error("Missing ASSISTANT_ID");
if (!process.env.VECTOR_STORE_ID) console.warn("Missing VECTOR_STORE_ID (file search won't attach per-run)");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Serve /public as static files
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Root: serve the chat UI
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Keep one OpenAI thread per browser via cookie
async function ensureThread(req, res) {
  let threadId = req.cookies?.thread_id;
  if (!threadId) {
    const t = await openai.beta.threads.create();
    threadId = t.id;
    res.cookie("thread_id", threadId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000, // 30 days
      path: "/"
    });
  }
  return threadId;
}

// Return conversation history for this thread (for the UI)
app.get("/history", async (req, res) => {
  try {
    const threadId = await ensureThread(req, res);
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const simplified = msgs.data.map(m => ({
      role: m.role,
      content: (m.content || []).map(c => c?.text?.value || "").join("\n")
    }));
    res.json({ ok: true, threadId, messages: simplified });
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Create a brand new thread and replace the cookie (for "New chat" button)
app.post("/new", async (_req, res) => {
  try {
    const t = await openai.beta.threads.create();
    res.cookie("thread_id", t.id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000,
      path: "/"
    });
    res.json({ ok: true, threadId: t.id });
  } catch (err) {
    console.error("NEW THREAD ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --- Diagnostics: verify env + assistant + vector store attachment
app.get("/diag", async (_req, res) => {
  try {
    const env = {
      has_api_key: !!process.env.OPENAI_API_KEY,
      assistant_id: process.env.ASSISTANT_ID || null,
      vector_store_id_env: process.env.VECTOR_STORE_ID || null
    };
    if (!env.has_api_key) return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY", env });

    let assistant = null;
    if (env.assistant_id) {
      assistant = await openai.beta.assistants.retrieve(env.assistant_id);
    }

    const tools = assistant?.tools || [];
    const assistantStoreIds =
      assistant?.tool_resources?.file_search?.vector_store_ids || [];

    res.json({
      ok: true,
      env,
      assistant: assistant
        ? {
            id: assistant.id,
            name: assistant.name,
            model: assistant.model,
            tools,
            tool_resources: { file_search: { vector_store_ids: assistantStoreIds } }
          }
        : null,
      hint:
        "You want tools to include {type:'file_search'} AND either assistant tool_resources to list your store OR VECTOR_STORE_ID env set (and attached per-run)."
    });
  } catch (err) {
    console.error("DIAG ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Chat endpoint: add user message, run assistant (with vector store), return last reply
app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    if (!process.env.ASSISTANT_ID) return res.status(500).json({ ok: false, error: "ASSISTANT_ID not set" });

    const threadId = await ensureThread(req, res);
    const { messages = [] } = req.body;

    // push incoming messages into the thread
    for (const m of messages) {
      await openai.beta.threads.messages.create(threadId, {
        role: m.role || "user",
        content: m.content || ""
      });
    }

    // Attach your Vector Store per-run so file_search is always available
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.ASSISTANT_ID,
      ...(process.env.VECTOR_STORE_ID
        ? {
            tool_resources: {
              file_search: { vector_store_ids: [process.env.VECTOR_STORE_ID] }
            }
          }
        : {})
    });

    // Poll with a hard deadline to avoid gateway timeouts
    const deadline = Date.now() + 45_000;
    let status = "queued";
    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      if (Date.now() > deadline) throw new Error("Timeout waiting for assistant.");
      const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
      status = r.status;
      if (!["completed", "failed", "cancelled", "expired"].includes(status)) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (status !== "completed") {
      return res.status(500).json({ ok: false, error: `Run ${status}` });
    }

    // --- Debug: list run steps so we can see tool use (file_search / retrieval)
    try {
      const steps = await openai.beta.threads.runs.steps.list(threadId, run.id);
      console.log(
        "RUN STEPS:",
        steps.data.map(s => ({
          id: s.id,
          type: s.type,
          status: s.status,
          details_type: s.step_details?.type
        }))
      );
    } catch (e) {
      console.warn("Could not fetch run steps:", e?.message || e);
    }

    // Fetch the latest assistant reply
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const lastAssistant = msgs.data.filter(m => m.role === "assistant").pop();
    const reply =
      lastAssistant?.content?.map(c => c.text?.value).filter(Boolean).join("\n").trim() || "(No reply)";

    res.json({ ok: true, reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --- Listen (use Render's PORT; local fallback for dev) ---
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});

// Graceful shutdown so old processes release the port
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
