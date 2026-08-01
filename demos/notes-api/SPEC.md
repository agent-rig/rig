# SPEC — Notes API

A tiny HTTP service for notes. This spec is the **desired state**: the code in
`src/` is the **actual state**, and `rig-sync` reconciles the two.

## API surface

The service exposes exactly these endpoints. Each row is one surface element
`METHOD /path`; `{id}` is a path parameter.

| Method | Path          | Purpose                     |
|--------|---------------|-----------------------------|
| GET    | /notes        | List all notes              |
| POST   | /notes        | Create a note               |
| GET    | /notes/{id}   | Fetch one note by id        |
| PUT    | /notes/{id}   | Replace a note by id        |
| DELETE | /notes/{id}   | Delete a note by id         |

## Invariants

- Every endpoint in this spec has a handler in `src/`.
- No **undocumented** endpoints: every route the code serves appears in the
  table above. (A health/metrics endpoint, if wanted, must be specced first.)

## Notes (the human kind)

This is deliberately small so the drift is easy to see. The code under `src/`
was written to *almost* match this spec — three things are out of sync. Run
`/rig-sync plan` to find them without reading the code first.
