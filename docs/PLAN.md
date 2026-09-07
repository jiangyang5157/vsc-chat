# VSC Chat Trail — Feature Plan

Scope note: this is the plan for the next phase of the project (v0.4+). It records
decisions, honest boundaries, and what will/won't be built. It is a living document —
update it when a decision changes.

## 1. Goal (restated)

Trail exists to help us answer, for **AI collaboration sessions done inside VS Code**,
two questions:

1. What actually happened? (audit/review — today's recorder)
2. How efficient is an internal AI tool? (the reason this plan exists)

The tools in question are developed by other people inside the company and run **as VS
Code chat participants / agents / extensions in the same window** (code review, Azure
Story analysis, code refactor, unit-test generation).

## 2. Decisions (confirmed)

| # | Decision | Consequence |
|---|---|---|
| D1 | **No per-tool token / cost accounting.** Real usage is only produced where the model request is made. VS Code's extension API does not expose usage for vendor chat, and even model *providers* lack a usage-reporting channel (see microsoft/vscode#330783). Nobody will provide usage exports, so we will not build an ingest/contract layer (former "Phase 1") and will not approximate tokens per tool. | Token figures must never be presented for third-party tools. |
| D2 | **No pilot with a single tool (former "Phase 4").** Dropped together with D1 — there is nothing to validate end-to-end without usage data. | — |
| D3 | **Efficiency is measured with time + effect proxies** that the extension API can observe reliably: text edits kept, terminal runs (time, exit code), commits, and activity traces. | These become the new report "efficiency" surface. |
| D4 | The only token-ish figure kept is the **existing coarse whole-session estimate** from the captured transcript (char-based, labeled `*`). It is optional, clearly marked, and never attributed to a specific tool. | No new token math anywhere. |
| D5 | **No cross-session aggregation (former "Phase 3") for now.** Aggregation means merging many sessions' reports for tool-vs-tool comparison; it is not the current goal. | Stays a backlog idea only. If it ever becomes needed, it requires the `<tool>:<task>` tag convention first — see Backlog. |
| D6 | **No rollout/validation phase (former "Phase 4") either.** Use the recorder in real work first; revisit only if real sessions show a clear need. | Nothing to build. |

## 3. Honest boundaries (why we measure what we measure)

- Native/vendor chat and other extensions' participant calls: request text, per-request
  tokens, cache hits, cost, chain-of-thought → **not available** to third-party
  extensions. Token breakdown exists only in VS Code's own UI.
- Org-level Copilot Usage Metrics API is the only official usage outlet, but it is
  per-seat/per-day and requires admin access — not per session, not per tool.
- Terminal **output volume** is not exposed by the API (only command line, timings, exit
  code). We therefore measure duration, not output size.
- Text-edit stats are a **proxy**: they count editor changes during the session; net
  added/removed chars can differ from the final git diff (formatting round-trips,
  reverts). Label them as proxy data.
- Window-focus events are coarse (focused/blurred) and cannot tell us which window or
  task the user went to.

## 4. Phase 2 — ambient effect signals (implemented in v0.4)

New events/data captured while a session is recording, in addition to the existing
file-save, terminal-command, model-call and transcript data:

| Signal | Mechanism | Meaning |
|---|---|---|
| Text edits (per file) | `workspace.onDidChangeTextDocument` → accumulate added/removed chars per relative path; content is **not** stored | "How much AI output was actually kept" proxy; totals in the report |
| Terminal run duration | pair `execution.creationTime` with the end event | How long a command (e.g. the tool's test run) took |
| Commits during session | at stop: `git log <startHead>..HEAD` (hash/date/subject) | Which AI work turned into commits |
| Active-file trace | `window.onDidChangeActiveTextEditor` → `editor_activity` events | What the user was working on, when |
| Window focus | `window.onDidChangeWindowState` → `window_focus` events (only on change) | Idle/away periods in the timeline |

Report surface: new "Session Totals" rows (terminal total duration, chars added/removed,
commits made), a "Commits Made During Session" section, and the new event types in the
timeline. JSON sidecar gains `editStats` and `commitsMade`.

### 4.1 Why this answers "efficiency" without tokens

For a unit-test writer or code reviewer, meaningful cheap proxies that don't need model
access are, over many sessions:

- duration of the tool's run (terminal) and its exit code (pass/fail proxy),
- how much text the session added and kept (accept proxy),
- whether the work ended in a commit and how many files it touched,
- how many back-and-forth editor switches / focus gaps occurred (friction proxy).

These are honest "time/effect" numbers: measured, not estimated. They support relative
comparisons (tool A vs tool B on similar tasks) even without token data — but they
cannot answer "cost per review". If a real cost answer is required later, it must come
from the tool's backend + admin approval, not from this extension.

## 5. Non-goals (explicitly out of scope)

- Per-tool token/cost/usage tracking and any estimation of them.
- Ingest/import of usage files from tool backends; public reporting API for other
  extensions (revisit only if a tool team ever offers real usage).
- Measuring terminal output volume or agent inner tool calls (API does not expose).
- Cross-session aggregation dashboards are **deferred** (still a future idea below).

## 6. Backlog (not committed — revisit when there is a real need)

- **Cross-session aggregation** (by task tag, per earlier plan): merge many sessions'
  reports and compare (avg duration, success proxies, change size). Explicitly **not
  needed now** (D5). If it ever becomes needed, adopt the `<tool>:<task>` tag convention
  (e.g. `review:PR-1234`, `utest:STORY-567`) so sessions can be attributed per tool
  without any cooperation from the tool teams.
- Revisit usage import (former Phase 1 contract) only if a tool team exports real usage
  or admin grants org-level Copilot Usage Metrics access (per-user/per-day granularity).
- Participant-level measured data: only if an internal tool team is willing to report
  through `trail.logModelCall` (then the "custom model calls" table gets real data).
- Session "accept/reject" signals for review tools (needs editor-action heuristics;
  research first).

## 7. Verification checklist (for v0.4)

- [ ] Start a session, open/edit files, run a terminal command, switch editors, blur and
      refocus the window, stop the session.
- [ ] Report shows: chars added/removed, terminal total duration, commits section,
      `editor_activity` / `window_focus` timeline rows.
- [ ] JSON sidecar contains `editStats` and `commitsMade`.
- [ ] No content is stored anywhere (only counts/paths/commands); output stays under
      `.vsc-chat-trail/`; nothing uploaded.
- [ ] No token figures appear for third-party tools.
