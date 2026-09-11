---
name: rig-preview
description: "Boot a running, seeded environment for a worktree so a human can manually test a change — starts db/backend/frontend as configured, seeds data via the project's existing seed mechanism (asking rig-qa what to seed, if anything), then launches an iOS Simulator or a Browser preview depending on app type. Prepares and reports; never judges pass/fail. Non-blocking step in /rig-task, after the review-bot loop. Triggers on: 'preview this', 'boot up for manual testing', 'set up manual QA', 'let me test this', 'spin up the environment', 'seed the db and preview'."
argument-hint: "[<worktree-path>] — defaults to the current worktree"
---

# rig-preview — a running, seeded environment for a human to test

Prepares the environment; does not evaluate it. The output of this skill is a
URL or a booted simulator plus a note on what's seeded — the human decides
whether the feature actually works. This is deliberately not an agent with
judgment: the one real decision inside it (what data to seed) is delegated to
`agents.qa`, which already knows how to read a diff for test scenarios.

Sits after the review-bot loop in `/rig-task` (Step 6.5) — code should be in
its final, post-fix-round state before you spend time booting an environment
around it. **Non-blocking**: a failure here is reported, never a reason to
withhold hand-back.

## Configuration

Reads `.rig/config.json`:

- `dev.dbCommand` — command to start a local database, if any. Absent/`none`
  → skip; not every project has one (this one doesn't).
- `dev.backendCommand` — command to start a backend/API server, if any.
  Absent/`none` → skip.
- `dev.frontendCommand` — command that serves the app (a bundler, a dev
  server). **Required for this skill to do anything** — there is no preview
  without something to preview. **Must contain a literal `{port}`
  placeholder** (e.g. `"npx expo start --port {port}"`) — `preview-env.sh`
  substitutes it before running. Without it, the command falls back to its
  own default port regardless of what `--port` this skill picked, and two
  worktrees can silently collide even though their configured ports differ.
- `dev.frontendPort` — the port `dev.frontendCommand` binds. Default `8081`.
- `dev.seedCommand` — command to seed local data, if the project has one.
  Absent/`none` → do not invent one (see Step 3).
- `dev.mobileBuildCommand` — **mobile apps only.** Command that builds and
  installs a native binary for a specific simulator device. Must contain a
  literal `{device}` placeholder (e.g. `"npx expo run:ios --device
  {device}"`). Absent → infer `npx expo run:ios --device {device}` if `expo`
  is a dependency; otherwise this is a gap — report it and stop before Step 5
  rather than guessing a bare-React-Native or Fastlane invocation.
- `agents.qa` (default `rig-qa`) — asked what to seed for this specific diff.

**Unconfigured (`dev` block absent entirely):** report that manual preview
isn't set up for this project yet, list what's missing, and stop — don't guess
commands.

## Steps

1. **Resolve the worktree.** Use the passed path, or infer from cwd (a path
   under `.claude/worktrees/`). If ambiguous, ask — don't guess which unit of
   work this is for.

2. **Detect app type**, to decide the launch step later:
   - `app.json` **and** (`ios/` or `android/` dir, or `expo`/`react-native` in
     `package.json` deps) → **mobile**.
   - Otherwise, if `dev.frontendCommand` serves HTTP → **web**.
   - Ambiguous → ask.

3. **Resolve what to seed.** If `dev.seedCommand` is set:
   - Spawn **qa** (`agents.qa`): "Given this diff/ticket, what data would a
     human need to see to manually verify it? Be concrete — counts, example
     values, edge cases worth having in view (an empty state, a negative
     number, a long name). Worktree: `{worktree-path}`."
   - If the project's seed command accepts parameters matching qa's plan, pass
     them. If it's a fixed/unparameterized seed script, run it as-is and
     **report qa's plan as "seeded data may not cover: …"** rather than
     silently treating a generic seed as sufficient.

   If `dev.seedCommand` is **absent**, don't write one yourself — this is a
   QA-prep step, not a coding task. Report "no seed mechanism configured;
   here's what a human would need to add by hand: `{qa's plan, if you still
   want it for reference}`" and continue to Step 4 regardless — an unseeded
   preview is still worth booting.

4. **Boot the stack.** Resolve `<SCRIPTS>` the same way `/rig-worktree` does
   (`.claude/scripts/` else `.rig/scripts/`), then, adding `--mobile` when
   Step 2 detected a mobile app:

   ```bash
   "$SCRIPTS/preview-env.sh" start --worktree "{worktree-path}" \
     --frontend "{dev.frontendCommand}" --port "{dev.frontendPort:-8081}" \
     [--backend "{dev.backendCommand}"] [--db "{dev.dbCommand}"] [--mobile]
   ```

   This handles both port-collision safety and — for `--mobile` — simulator
   **device** allocation itself (see the script's own header): two worktrees
   installing the same bundle identifier onto the same device silently
   overwrite each other, so each mobile worktree gets its own exclusive
   device. If it refuses (port held by another live worktree, or every
   device is claimed), surface that verbatim; don't retry with
   `--force-kill-port` or manually pick a device on your own judgment — the
   human decides whether to free something up.

   If `dev.seedCommand` was resolved in Step 3, run it now, after the backend
   (if any) is up and before declaring the environment ready.

5. **Launch the preview.** Read the device (if any) and port back from
   `<worktree>/.rig-preview.json`, the file the script just wrote:
   - **Mobile — always run a real native build+install for THIS worktree,
     onto its own allocated device. Never assume an existing install on that
     device already reflects this worktree's code, even if the device
     already has the app installed from an earlier session or a different
     worktree.** This is not an optimization to skip when convenient — a
     deep-link reconnect to an already-installed binary was tried and proven
     unreliable (zero requests reached the target bundler in testing; the app
     kept rendering the previous binary's cached bundle with no error). Run:
     ```bash
     {dev.mobileBuildCommand with {device} substituted for the metadata's device UDID}
     ```
     This both installs and launches — Expo's `run:ios` (and equivalents)
     start the app already pointed at the locally running bundler, so there
     is no separate deep-link/open-url step. Attach the iOS Simulator panel
     to the **device UDID from the metadata file** first (not whatever's
     already frontmost — with multiple worktrees previewing at once, the
     "current" device is ambiguous), so the human sees the build happen.
     Take a screenshot once it renders and include it in your report — a
     human reading chat should see the environment is actually up, not just
     take "started" on faith. **Known tradeoff:** a full native build costs
     real time (a minute or more) on every `rig-preview` call, even for a
     JS-only change. That cost is deliberate until reconnect-without-rebuild
     is proven reliable — reporting a stale preview as "ready" is worse than
     the wait.
   - **Web** — open the Browser preview at `http://localhost:{port}` (or
     configure `.claude/launch.json` if this worktree doesn't have one yet,
     same as any other preview target) and confirm it renders before
     reporting success. No native build applies here — a web preview is
     just the URL; there's no installed binary that could be stale.

6. **Report.** One block, not scattered narration:
   ```
   rig-preview: {ticket-id or ad-hoc description}
   worktree: {path}
   frontend: http://localhost:{port} (pid {n})    [+ backend/db pids if started]
   seeded: {what qa asked for, and whether the seed command actually covers it}
   preview: {simulator device name + UDID, or the browser tab} — verified rendering
   ```
   State plainly what you did **not** verify (e.g. "did not exercise the
   actual feature — that's yours to test").

## Teardown

There is no separate `rig-preview stop`. Everything this skill starts is torn
down by **`/rig-worktree rm`** — `remove-worktree.sh` reads the
`.rig-preview.json` metadata `preview-env.sh` wrote and kills every recorded
process before removing the worktree. This is a deliberate scope choice: one
lifecycle (the worktree's), not two commands to remember. The tradeoff: if you
want to stop a preview but keep the worktree around, there's no dedicated
command for that today — kill the PIDs from `.rig-preview.json` by hand, or
just remove the worktree once you're actually done.
