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

// New SDK client
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

/** ----------------- HISTORY (with optional thread_id switch) ----------------- */
app.get("/history", async (req, res) => {
  try {
    const requested = req.query.thread_id;
    let threadId;

    if (requested) {
      // Use the requested thread and set it as current cookie
      threadId = requested;
      res.cookie("thread_id", requested, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 3600 * 1000,
        path: "/"
      });
    } else {
      threadId = await ensureThread(req, res);
    }

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

/** ----------------- NEW THREAD ----------------- */
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
        hint: "All files should be status=completed. file_counts.total should match your expectations."
      });
    }

    const headers = {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    const storeResp = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}`, { headers });
    if (!storeResp.ok) {
      const t = await storeResp.text();
      throw new Error(`Vector store retrieve failed: ${storeResp.status} ${t}`);
    }
    const store = await storeResp.json();

    const filesResp = await fetch(`https://api.openai.com/v1/vector_stores/${storeId}/files?limit=100`, { headers });
    if (!filesResp.ok) {
      const t = await filesResp.text();
      throw new Error(`Vector store files list failed: ${filesResp.status} ${t}`);
    }
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
      hint: "All files should be status=completed. file_counts.total should match your expectations."
    });
  } catch (err) {
    console.error("DIAG STORE ERROR:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

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

/** ----------------- FILE DOWNLOAD PROXY -----------------
 * Allows the frontend to download assistant-generated files via /file/:id
 */
app.get("/file/:id", async (req, res) => {
  try {
    const fileId = req.params.id;
    if (!fileId) return res.status(400).send("Missing file id");

    const fileInfo = await openai.files.retrieve(fileId).catch(() => null);
    const filename = fileInfo?.filename || `${fileId}.bin`;

    const contentResp = await openai.files.content(fileId);
    const arrayBuffer = await contentResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("FILE PROXY ERROR:", err);
    res.status(500).send("Failed to fetch file content.");
  }
});

/** ----------------- CHAT ----------------- */
app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    if (!process.env.ASSISTANT_ID) return res.status(500).json({ ok: false, error: "ASSISTANT_ID not set" });

    const threadId = await ensureThread(req, res);
    const { messages = [], system = null } = req.body;

    for (const m of messages) {
      await openai.beta.threads.messages.create(threadId, {
        role: m.role || "user",
        content: m.content || ""
      });
    }

    // Enable both file_search and code_interpreter on the run,
    // and attach your vector store if provided.
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.ASSISTANT_ID,
      tools: [
        { type: "file_search" },
        { type: "code_interpreter" }
      ],
      ...(process.env.VECTOR_STORE_ID
        ? { tool_resources: { file_search: { vector_store_ids: [process.env.VECTOR_STORE_ID] } } }
        : {}),
      ...(system ? { instructions: system } : {})
    });

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

    // Optionally log run steps for debugging and to find files produced by code_interpreter
    let producedFileIds = new Set();
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

      // Try to extract file ids from code_interpreter outputs if present
      for (const s of steps.data) {
        const calls = s?.step_details?.tool_calls || [];
        for (const c of calls) {
          if (c?.type === "code_interpreter") {
            const outs = c?.code_interpreter?.outputs || [];
            for (const o of outs) {
              // Different SDKs represent this slightly differently; handle common shapes
              const maybeFileId =
                o?.file_id ||
                o?.image_file_id ||
                o?.image?.file_id ||
                o?.file?.id ||
                null;
              if (maybeFileId) producedFileIds.add(maybeFileId);
            }
          }
        }
      }
    } catch (e) {
      console.warn("Could not fetch/parse run steps for file outputs:", e?.message || e);
    }

    // Fetch final assistant message
    const msgs = await openai.beta.threads.messages.list(threadId, { order: "asc" });
    const lastAssistant = msgs.data.filter(m => m.role === "assistant").pop();

    // Collect text
    let reply =
      lastAssistant?.content?.map(c => c.text?.value).filter(Boolean).join("\n").trim() || "(No reply)";

    // Collect any files referenced directly in message parts or annotations
    const discoveredFiles = [];
    try {
      for (const part of (lastAssistant?.content || [])) {
        // file_path / image_file parts
        const partFileId =
          part?.file_path?.file_id ||
          part?.image_file?.file_id ||
          null;
        if (partFileId) producedFileIds.add(partFileId);

        if (part?.type === "text") {
          const anns = part?.text?.annotations || [];
          for (const a of anns) {
            const annId = a?.file_path?.file_id || a?.file_citation?.file_id || null;
            if (annId) producedFileIds.add(annId);
          }
        }
      }

      // Turn set into enriched list with filenames
      for (const id of producedFileIds) {
        try {
          const info = await openai.files.retrieve(id);
          discoveredFiles.push({
            id,
            filename: info?.filename || id,
            url: `/file/${id}`
          });
        } catch {
          discoveredFiles.push({ id, filename: id, url: `/file/${id}` });
        }
      }

      if (discoveredFiles.length) {
        const listText = discoveredFiles
          .map(f => `- ${f.filename}: ${f.url}`)
          .join("\n");
        // Append file links to the reply so your current UI shows them
        reply = `${reply}\n\nFiles:\n${listText}`;
      }

      // Log citations vs. no citations (for retrieval debugging)
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
    } catch (e) {
      console.warn("File discovery error:", e?.message || e);
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
