import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// simple API-key gate so randos can't hit your endpoint (optional)
app.use((req, res, next) => {
  const required = process.env.CLIENT_API_KEY;
  if (!required) return next(); // no gate if you didn't set it
  const incoming = req.header("X-API-Key");
  if (incoming !== required) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// Health check
app.get("/", (_req, res) => res.send("RERAW AI Coach is live."));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * POST /chat
 * Body:
 * {
 *   "messages": [
 *     { "role": "user", "content": "Your question here" }
 *   ]
 * }
 */
app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    }
    if (!process.env.ASSISTANT_ID) {
      return res.status(500).json({ ok: false, error: "ASSISTANT_ID not set" });
    }

    const { messages = [] } = req.body;

    // 1) Create a new thread
    const thread = await openai.beta.threads.create();

    // 2) Send user messages into the thread
    for (const m of messages) {
      await openai.beta.threads.messages.create(thread.id, {
        role: m.role || "user",
        content: m.content || ""
      });
    }

    // 3) Run the assistant that already has your files/vector store attached
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID
      // If you didn't attach the vector store in the dashboard and want to attach at runtime:
      // tool_resources: { file_search: { vector_store_ids: [process.env.VECTOR_STORE_ID] } }
    });

    // 4) Poll until the run completes (beginner-friendly; streaming can come later)
    let status = "queued";
    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      const r = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      status = r.status;
      if (!["completed", "failed", "cancelled", "expired"].includes(status)) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (status !== "completed") {
      return res.status(500).json({ ok: false, error: `Run ${status}` });
    }

    // 5) Pull the last assistant message
    const msgs = await openai.beta.threads.messages.list(thread.id, { order: "asc" });
    const lastAssistant = msgs.data.filter(m => m.role === "assistant").pop();
    const reply =
      lastAssistant?.content?.map(c => c.text?.value).filter(Boolean).join("\n").trim() ||
      "(No reply)";

    return res.json({ ok: true, reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Server listening on", process.env.PORT || 10000);
});
