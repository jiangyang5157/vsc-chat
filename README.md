# VSC Chat Trail

A VS Code extension that records one **AI collaboration session** in the chat/agent window like a "video recorder" and, when you stop it, exports an **HTML audit report + JSON** — so you can audit and review what that AI collaboration actually changed, how long it took, and what events happened.

- **Local-only**: data never leaves your workspace, nothing is uploaded
- **No API key**; the extension itself **never calls a model**
- **No build step** (pure JavaScript)

> History: v0.2 shipped two experimental chat participants (`@probe`, which probed model access, and `@asb-runbook`, a local runbook search). Both checks passed and were not part of the daily workflow, so v0.3 removed them; see git history if you need to replicate them.

## What is recorded (all "world changes" the extension API can see)

| Category | Content |
|---|---|
| git | Branch/HEAD at start and end, the full diff since the start HEAD (stat + file list), untracked new files, commits made during the session |
| Text edits | Per-file added/removed character counts (content is never stored) — a proxy for how much AI output was kept |
| Timeline | File saves, terminal commands (needs Shell Integration, incl. duration), model calls reported by custom participants, active-file switches, window focus changes |
| Transcript | Tries the official Export Conversation command at the end to capture the current session text |

**We never fabricate data**: vendor chat (e.g. GitHub Copilot) does not expose tokens/cache hits/cost/chain-of-thought to extensions. Efficiency is measured with **time/effect proxies** (edits kept, terminal runs, commits, activity), never guessed tokens for third-party tools. See `docs/PLAN.md` for the reasoning and boundaries.

## File structure

```
vsc-chat/
├── package.json          # Extension manifest: Trail commands + setting (vscChatTrail.outputDir)
├── extension.js          # Activation entry point (only registers Trail)
├── trail.js              # Recorder: event listeners + git diff/commits + edit stats + transcript + export
├── report-builder.js     # HTML/JSON artifact generation (pure functions, no vscode dependency, testable standalone)
├── docs/PLAN.md          # Feature plan, decisions, and honest boundaries
├── .vscode/launch.json   # F5 debug configuration
└── README.md
```

## Prerequisites

1. VS Code ≥ 1.100
2. A vendor chat extension installed and signed in (currently GitHub Copilot Chat)
3. (Recommended) The workspace is inside a git repository — git diff and changed-file data depend on it
4. No Node / build tools needed

## Getting started

1. Open this folder (`vsc-chat`) in VS Code
2. Press **F5** → an `[Extension Development Host]` window opens — do everything in that new window
3. In the new window run `Ctrl+Shift+P` → **VSC Chat Trail: ▶ Start session**

## Usage

```text
1. Open a workspace (a git repository is recommended)
2. Ctrl+Shift+P → VSC Chat Trail: ▶ Start session
   (optionally enter a task tag, e.g. STORY-1234 / review / fix-bug — reserved for future
    per-task/per-skill aggregation analysis)
3. Work normally: open chat / agent, have it change code, run tests… events are recorded
   automatically; nothing else to do
4. Ctrl+Shift+P → VSC Chat Trail: ■ Stop session and export artifact
   → the audit report opens in your browser
```

Report sections: Session metadata (incl. task tag) → **Session Totals** (duration / saves / terminal runs + total time / changed files / text edits added-removed / commits / custom model calls) → AI Changes Summary (git) → Commits Made During Session → Timeline (saves, terminal, active-file, window focus) → Model-call table (only when custom participants report) → Transcript snapshot → Known limitations.

Data is written to `<workspace>/.vsc-chat-trail/`: `sessions/*.jsonl` (raw event stream) + `reports/*.html|.json` (gitignored). The JSON carries the same data as the artifact, for future scripted session/skill aggregation.

## Honest boundaries (why some data is missing)

- **Model chain-of-thought and per-tool inputs/outputs**: vendor chat does not expose them to any extension.
- **Real tokens / cache hits / cost of native conversations**: the extension API has no usage field. The only official path is the org-level Copilot metrics API (requires admin) — and that only reaches "per user per day", not per session.
- **Which concrete model "auto" routes to**: unknowable for native chat; only custom participants can record the currently selected dropdown model.
- So the report only claims what it measured (latency, chars, git, events); all tokens are character estimates marked `*`. Separating fact from inference is the baseline for audit material.

## FAQ

**Q: Does this extension call models or consume my chat quota?**
A: No. VSC Chat Trail only listens to events, captures git diffs, and tries the official export command for a transcript snapshot. It never initiates a model call itself.

**Q: Why is the "Model calls by custom participants" table empty?**
A: That table only records model calls that a custom participant reports through `trail.logModelCall`. This extension currently registers no model-calling participants (the early validation participants @probe / @asb-runbook were removed in v0.3). If you only use the native chat window, this table is legitimately empty — vendor chat does not expose native conversation usage to extensions. Not a bug; a boundary.

**Q: Can Trail measure tokens/cost of the internal AI tools (review / story / refactor / tests)?**
A: No per-tool tokens, by design. Real usage is only produced where the model request happens (the tools' own backend or Copilot's org metrics API, which is per-user/per-day and needs admin). The extension API exposes no usage for vendor chat. Trail therefore measures **time/effect proxies** instead — how long runs took, how much edited text was kept, what got committed, when work happened — which supports relative efficiency comparisons without guessing tokens. Rationale: `docs/PLAN.md`.

**Q: Why does the report show `?*` tokens / no token data?**
A: Tokens are always estimates marked `*`. They only exist when there is text to estimate (a captured transcript) or a custom participant reported a call.

**Q: What per-session totals can I actually rely on?**
A: Measured or explicitly estimated only: recording duration, file-save count, terminal-command count, git changed-file count, transcript length and estimated tokens. Not available: real tokens/cost/cache hits of native conversations (no API outlet; org-level metrics API is the only official path, requires admin, and cannot reach single-session granularity).

## Checklist to send to your admin

1. (Optional, for real usage data) Can the org-level **Copilot metrics API** read permission be granted?
2. (Future, if you register model-calling custom participants) Does the Enterprise policy allow third-party chat extensions? Who controls the model dropdown and what does "auto" actually route to?
3. (Future, if you add tool points to the agent) Is there an MCP tool whitelist policy?

## Roadmap

- [x] v0.2: Recording + git diff + transcript snapshot + task tags + session totals + HTML/JSON artifacts
- [x] v0.3: Removed the validation participants @probe / @asb-runbook; narrowed to a pure Trail tool
- [x] v0.4: Ambient effect signals — text-edit stats, terminal run duration, commits during session, active-file / window-focus events
- [ ] Cross-session aggregation analysis: per task-tag/skill statistics (avg duration, success proxies, change size)
- [ ] (Future) Register a model-calling custom participant (e.g. @asb-review) that reports measured data via `trail.logModelCall`
