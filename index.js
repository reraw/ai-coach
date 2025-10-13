import express from "express";
const app = express();

app.get("/", (_req, res) => res.send("RERAW AI Coach is live."));
app.listen(process.env.PORT || 10000, () =>
  console.log("Server listening")
);
