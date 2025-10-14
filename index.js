// index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

// --- path setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- app setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// --- env checks ---
if (!process.env.OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");
if (!process.env.ASSISTANT_ID) console.error("Missing ASSISTANT_ID");

// allow either name for the core store
const CORE_VECTOR_STORE_ID =
  process.env.CORE_VECTOR_STORE_ID || process.env.VECTOR_STORE_ID;
if (!CORE_VECTOR_STORE_ID)
  console.warn(
    "No vector store id set (CORE_VECTOR_STORE_ID or VECTOR_STORE_ID). Retrieval will still work if the Assistant already has a store attached."
  );

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- utility: ensure a thread cookie (fallback if client doesn't pass threadId) ---
async function ensureThread(req, res) {
  let threadId = req.cookies?.thread_id;
  if (!threadId) {
    const t = await openai.beta.threads.create();
    threadId = t.id;
    res.cookie("thread_id", threadId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 3600 * 1000,
    });
  }
  return threadId;
}

// --- health & root ---
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- thread ops ---
// create new thread (sets cookie and returns id)
app.post("/new", async (_req, res) => {
  try {
    const t = await openai.beta.threads.create();
    res.cookie("thread_id", t.id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.json({ ok: true, threadId: t.id });
  } catch (err) {
    console.error("NEW THREAD ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// switch current cookie to a known thread (client holds list)
app.post("/thread/switch", async (req, res) => {
  try {
    const { threadId } = req.body || {};
    if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
    // (Optionally we could verify it exists by retrieving; not required.)
    res.cookie("thread_id", threadId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("SWITCH ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// delete a thread (server-side)
app.delete("/thread", async (req, res) => {
  try {
    const { threadId } = req.query || {};
    if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
    await openai.beta.threads.del(threadId);
    // clear cookie if it matches
    if (req.cookies?.thread_id === threadId) {
      res.clearCookie("thread_id", { path: "/" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE THREAD ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// get history for a thread
app.get("/history", async (req, res) => {
  try {
    const threadId = req.query.threadId || (await ensureThread(req, res));
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const simplified = msgs.data.map((m) => ({
      id: m.id,
      role: m.role,
      content: (m.content || [])
        .map((c) => c?.text?.value || "")
        .filter(Boolean)
        .join("\n"),
    }));
    res.json({ ok: true, threadId, messages: simplified });
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --- chat ---
// strong per-run system instructions (RERAW voice, retrieval-first)
const RERAW_SYSTEM = `
You are "RERAW AI Coach" for real estate agents. Always:
- Lead with direct, no-fluff, practical guidance that reflects James' RERAW style (confident, candid, ethical, modern, results-oriented).
- Prefer step-by-step playbooks, templates, scripts, and checklists over vague advice.
- **Use file_search** aggressively. If relevant docs are attached via vector store, cite them with brief, inline brackets like [Doc: <filename or short handle>].
- If the user's ask conflicts with RERAW docs, warn, then provide the recommended RERAW way.
- If something isn't in the docs, say so briefly and proceed with your best expert judgment (still in RERAW style).
- Keep responses tight but actionable. Bullets > long paragraphs.
- No hallucinations. No fake stats.
`;

app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    if (!process.env.ASSISTANT_ID) return res.status(500).json({ ok: false, error: "ASSISTANT_ID not set" });

    // allow client to choose which thread to use
    const threadId = req.body.threadId || (await ensureThread(req, res));
    const { messages = [] } = req.body;

    // append user messages
    for (const m of messages) {
      await openai.beta.threads.messages.create(threadId, {
        role: m.role || "user",
        content: m.content || "",
      });
    }

    // build tool resources
    const toolResources = CORE_VECTOR_STORE_ID
      ? { file_search: { vector_store_ids: [CORE_VECTOR_STORE_ID] } }
      : undefined;

    // run with strong per-run instructions
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.ASSISTANT_ID,
      additional_instructions: RERAW_SYSTEM,
      ...(toolResources ? { tool_resources: toolResources } : {}),
      // optional: nudge retrieval behavior a bit more
      // metadata: { retrieval_priority: "high" }
    });

    // poll until done
    const deadline = Date.now() + 60_000;
    let status = "queued";
    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      if (Date.now() > deadline) throw new Error("Timeout waiting for assistant.");
      const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
      status = r.status;
      if (!["completed", "failed", "cancelled", "expired"].includes(status)) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (status !== "completed") {
      return res.status(500).json({ ok: false, error: `Run ${status}` });
    }

    // debug steps (helps verify tool_calls when retrieval is used)
    try {
      const steps = await openai.beta.threads.runs.steps.list(threadId, run.id);
      console.log(
        "RUN STEPS:",
        steps.data.map((s) => ({
          id: s.id,
          type: s.type,
          status: s.status,
          details_type: s.step_details?.type,
        }))
      );
    } catch (e) {
      console.warn("Could not fetch run steps:", e?.message || e);
    }

    // get reply
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const lastAssistant = msgs.data.filter((m) => m.role === "assistant").pop();
    const reply =
      lastAssistant?.content
        ?.map((c) => c?.text?.value)
        .filter(Boolean)
        .join("\n")
        .trim() || "(No reply)";

    // log any citations
    try {
      const textParts = (lastAssistant?.content || []).filter((p) => p.type === "text");
      const annotations = [];
      for (const p of textParts) {
        for (const a of p.text?.annotations || []) {
          annotations.push({
            type: a.type,
            file_id: a.file_citation?.file_id || a.file_path?.file_id || null,
            start_index: a.start_index,
            end_index: a.end_index,
          });
        }
      }
      if (annotations.length) console.log("CITATIONS:", annotations);
      else console.log("CITATIONS: (none)");
    } catch (e) {
      console.warn("Could not parse annotations:", e?.message || e);
    }

    res.json({ ok: true, threadId, reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --- diagnostics (still helpful) ---
app.get("/diag", async (_req, res) => {
  try {
    const env = {
      has_api_key: !!process.env.OPENAI_API_KEY,
      assistant_id: process.env.ASSISTANT_ID || null,
      core_vector_store_id: CORE_VECTOR_STORE_ID || null,
    };
    let assistant = null;
    if (env.assistant_id) assistant = await openai.beta.assistants.retrieve(env.assistant_id);
    const assistantStoreIds = assistant?.tool_resources?.file_search?.vector_store_ids || [];
    res.json({
      ok: true,
      env,
      assistant: assistant
        ? {
            id: assistant.id,
            name: assistant.name,
            model: assistant.model,
            tools: assistant.tools,
            tool_resources: { file_search: { vector_store_ids: assistantStoreIds } },
          }
        : null,
    });
  } catch (err) {
    console.error("DIAG ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --- listen ---
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
