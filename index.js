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
if (!process.env.VECTOR_STORE_ID) console.warn("VECTOR_STORE_ID not set (we'll still try per-assistant)");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Strong per-run instructions to force grounding
const SYSTEM_INSTRUCTIONS = `
You are the RERAW AI Coach for James (founder of RERAW).
MANDATES:
1) Use the file_search tool to fetch relevant passages from the attached RERAW vector store BEFORE answering.
2) Ground your answer directly in the docs: quote or tightly paraphrase.
3) For any doc-sourced statements, add inline bracket citations at the end of the sentence: [doc].
4) If the docs do NOT support the answer, reply first line: "Not in RERAW docs."
   Then add a short "General Guidance" paragraph with best-practice advice (brief).
STYLE: direct, no fluff, practical, step-by-step. Avoid generic realtor clichés. Speak like a seasoned coach.
SAFETY: For legal/financial topics, flag the limitation and offer practical alternatives.
`;

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

/** ----------------- DIAGNOSTICS ----------------- */

// /diag -> env + assistant metadata + attached vector stores
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

// /diag/store -> vector store info + file list & statuses (SDK + REST fallback)
app.get("/diag/store", async (_req, res) => {
  try {
    const storeId = process.env.VECTOR_STORE_ID;
    if (!storeId) return res.status(400).json({ ok: false, error: "VECTOR_STORE_ID not set" });

    if (openai?.beta?.vectorStores) {
      const store = await openai.beta.vectorStores.retrieve(storeId);
      const files = await openai.beta.vectorStores.files.list(storeId, { limit: 100 });
      return res.json({
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
        hint: "All files should be status=completed."
      });
    }

    const headers = {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    const storeResp = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}`, { headers });
    if (!storeResp.ok) throw new Error(`Vector store retrieve failed: ${storeResp.status} ${await storeResp.text()}`);
    const store = await storeResp.json();

    const filesResp = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}/files?limit=100`, { headers });
    if (!filesResp.ok) throw new Error(`Vector store files list failed: ${filesResp.status} ${await filesResp.text()}`);
    const filesJson = await filesResp.json();

    return res.json({
      ok: true,
      store: {
        id: store.id,
        name: store.name,
        status: store.status,
        file_counts: store.file_counts
      },
      files: (filesJson.data || []).map(f => ({
        id: f.id,
        status: f.status,
        created_at: f.created_at
      })),
      hint: "All files should be status=completed."
    });
  } catch (err) {
    console.error("DIAG STORE ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// /diag/last -> last assistant message + any file annotations (citations)
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

/** ----------------- CHAT ----------------- */

app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    if (!process.env.ASSISTANT_ID) return res.status(500).json({ ok: false, error: "ASSISTANT_ID not set" });

    const threadId = await ensureThread(req, res);
    const { messages = [] } = req.body;

    // Push user messages into thread
    for (const m of messages) {
      await openai.beta.threads.messages.create(threadId, {
        role: m.role || "user",
        content: m.content || ""
      });
    }

    // Create the run (attach vector store per-run + strong instructions)
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.ASSISTANT_ID,
      additional_instructions: SYSTEM_INSTRUCTIONS,
      ...(process.env.VECTOR_STORE_ID
        ? { tool_resources: { file_search: { vector_store_ids: [process.env.VECTOR_STORE_ID] } } }
        : {})
    });

    // Poll for completion
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

    // Get run steps for diagnostics
    let runSteps = [];
    try {
      const steps = await openai.beta.threads.runs.steps.list(threadId, run.id);
      runSteps = steps.data.map(s => ({
        id: s.id,
        type: s.type,
        status: s.status,
        details_type: s.step_details?.type
      }));
      console.log("RUN STEPS:", runSteps);
    } catch (e) {
      console.warn("Could not fetch run steps:", e?.message || e);
    }

    // Fetch last assistant message
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const lastAssistant = msgs.data.filter(m => m.role === "assistant").pop();

    let reply =
      lastAssistant?.content?.map(c => c.text?.value).filter(Boolean).join("\n").trim() || "(No reply)";

    // Collect citations (file IDs) from annotations and enrich with filenames
    const citations = [];
    try {
      const textParts = (lastAssistant?.content || []).filter(p => p.type === "text");
      for (const p of textParts) {
        for (const a of (p.text?.annotations || [])) {
          const id = a.file_citation?.file_id || a.file_path?.file_id || null;
          if (id) citations.push({ file_id: id });
        }
      }
    } catch (_) {}

    // De-dupe and fetch filenames
    const byId = new Map();
    for (const c of citations) {
      if (!byId.has(c.file_id)) {
        try {
          const f = await openai.files.retrieve(c.file_id);
          byId.set(c.file_id, f.filename || c.file_id);
        } catch {
          byId.set(c.file_id, c.file_id);
        }
      }
    }
    const enrichedCitations = citations.map(c => ({
      file_id: c.file_id,
      filename: byId.get(c.file_id)
    }));

    if (enrichedCitations.length) {
      console.log("CITATIONS:", enrichedCitations);
    } else {
      console.log("CITATIONS: (none)");
    }

    return res.json({ ok: true, reply, citations: enrichedCitations, run_steps: runSteps });
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
