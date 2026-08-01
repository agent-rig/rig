// Notes API — the ACTUAL state. Compare against ../SPEC.md.
//
// An Express-style router. rig-sync doesn't run this; the extractor
// (.rig/rig-sync-extractor) reads the route declarations below as the code's
// actual surface. Three things drift from the spec on purpose.

const express = require("express");
const app = express();
app.use(express.json());

const notes = new Map();
let nextId = 1;

// GET /notes — list all notes
app.get("/notes", (req, res) => {
  res.json([...notes.values()]);
});

// POST /notes — create a note
app.post("/notes", (req, res) => {
  const id = String(nextId++);
  const note = { id, body: req.body.body ?? "" };
  notes.set(id, note);
  res.status(201).json(note);
});

// GET /notes/:id — fetch one note
app.get("/notes/:id", (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) return res.status(404).json({ error: "not found" });
  res.json(note);
});

// PATCH /notes/:id — partially update a note
// (the spec asks for PUT /notes/{id} — a full replace. Method drift.)
app.patch("/notes/:id", (req, res) => {
  const note = notes.get(req.params.id);
  if (!note) return res.status(404).json({ error: "not found" });
  if (req.body.body !== undefined) note.body = req.body.body;
  res.json(note);
});

// GET /health — liveness probe
// (not in the spec at all — an undocumented endpoint.)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// NOTE: there is no DELETE /notes/:id handler — the spec asks for one.

module.exports = app;
