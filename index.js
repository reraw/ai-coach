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
if (!process.env.VECTOR_STORE_ID) console.error("Missing VECTOR_STORE_ID (file search may not attach per-run)");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Serve static UI
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Root
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Create a thread per browser via cookie
async function ensureThread(req, res) {
  let threadId = req.cookies?.thread_id;
  if (!threadId) {
    const t = await openai.beta.threads.create();
    threadId = t.id;
    res.cookie("thread_id", threadId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 3600 * 1000,
      path: "/"
    });
  }
  return threadId;
}

// Get history (for UI)
app.get("/history", async (req, res) => {
  try {
    const threadId = await ensureThread(req, res);
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const simplified = msgs.data.map(m => ({
      role: m.role,
      // join all text parts; ignore images
      content: (m.content || []).map(c => c?.text?.value || "").join("\n")
    }));
    res.json({ ok: true, threadId, messages: simplified });
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// New chat (fresh thread)
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

/**
 * --- DIAGNOSTICS ---
 * /diag         -> env + assistant metadata + attached vector stores
 * /diag/store   -> vector store info + file list & statuses
 * /diag/last    -> last assistant message with any file annotations (citations)
 */
app.get("/diag", async (_req, res) => {
  try {
    const env = {
      has_api_key: !!process.env.OPENAI_API_KEY,
      assistant_id: process.env.ASSISTANT_ID || null,
      vector_store_id_env: process.env.VECTOR_STORE_ID || null
    };
    if (!env.has_api_key) return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY", env });

    let assistant = null;
    if (env.assistant_id) assistant = await openai.beta.assistants.retrieve(env.assistant_id);

    const tools = assistant?.tools || [];
    const assistantStoreIds = assistant?.tool_resources?.file_search?.vector_store_ids || [];

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
      hint: "Model must support file_search; tools must include {type:'file_search'}; store IDs must be present here and/or attached per-run."
    });
  } catch (err) {
    console.error("DIAG ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Vector store detail + file list
app.get("/diag/store", async (_req, res) => {
  try {
    const storeId = process.env.VECTOR_STORE_ID;
    if (!storeId) return res.status(400).json({ ok: false, error: "VECTOR_STORE_ID not set" });

    const store = await openai.beta.vectorStores.retrieve(storeId);
    // list first 100 files (adjust as needed)
    const files = await openai.beta.vectorStores.files.list(storeId, { limit: 100 });

    res.json({
      ok: true,
      store: {
        id: store.id,
        name: store.name,
        status: store.status,
        file_counts: store.file_counts
      },
      files: files.data.map(f => ({
        id: f.id,
        status: f.status,
        created_at: f.created_at
      })),
      hint: "All files should be status=completed. file_counts.total should match your expectations."
    });
  } catch (err) {
    console.error("DIAG STORE ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Show the last assistant message and any annotations/citations it used
app.get("/diag/last", async (req, res) => {
  try {
    const threadId = req.cookies?.thread_id;
    if (!threadId) return res.json({ ok: true, message: "No thread yet." });

    const msgs = await openai.beta.threads.messages.list(threadId, { order: "desc" });
    const lastAssistant = msgs.data.find(m => m.role === "assistant");
    if (!lastAssistant) return res.json({ ok: true, message: "No assistant message yet." });

    const parts = lastAssistant.content || [];
    const textParts = parts.filter(p => p.type === "text");
    const text = textParts.map(p => p.text?.value || "").join("\n");

    // Gather any annotations -> look for file_citation style annotations
    const annotations = [];
    for (const p of textParts) {
      for (const a of (p.text?.annotations || [])) {
        // a.type could be "file_citation", "file_path", etc.
        annotations.push({
          type: a.type,
          file_id: a.file_citation?.file_id || a.file_path?.file_id || null,
          start_index: a.start_index,
          end_index: a.end_index
        });
      }
    }

    res.json({
      ok: true,
      assistant_message_id: lastAssistant.id,
      text_preview: text.slice(0, 800),
      annotations,
      hint: "If annotations list file IDs, retrieval happened. If empty, the model didn't cite files."
    });
  } catch (err) {
    console.error("DIAG LAST ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Chat: add message, run assistant (attach vector store), return reply
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
      // you can also inject extra guardrails here via 'instructions'
      ...(process.env.VECTOR_STORE_ID
        ? { tool_resources: { file_search: { vector_store_ids: [process.env.VECTOR_STORE_ID] } } }
        : {})
    });

    // Poll with a deadline
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

    // Fetch the latest assistant reply + print citations if present
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const lastAssistant = msgs.data.filter(m => m.role === "assistant").pop();

    let reply =
      lastAssistant?.content?.map(c => c.text?.value).filter(Boolean).join("\n").trim() || "(No reply)";

    // Log any annotations/citations to server logs for proof of retrieval
    try {
      const textParts = (lastAssistant?.content || []).filter(p => p.type === "text");
      const annotations = [];
      for (const p of textParts) {
        for (const a of (p.text?.annotations || [])) {
          annotations.push({
            type: a.type,
            file_id: a.file_citation?.file_id || a.file_path?.file_id || null,
            start_index: a.start_index,
            end_index: a.end_index
          });
        }
      }
      if (annotations.length) {
        console.log("CITATIONS:", annotations);
      } else {
        console.log("CITATIONS: (none)");
      }
    } catch (e) {
      console.warn("Could not parse annotations:", e?.message || e);
    }

    res.json({ ok: true, reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Listen (Render's PORT; local fallback)
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
