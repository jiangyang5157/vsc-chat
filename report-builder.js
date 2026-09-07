// report-builder.js — pure functions that render one trail session's data into an
// HTML audit report / JSON sidecar. Does not depend on vscode, so it can be tested
// standalone with node.
'use strict';

// ---------- token estimation (explicitly marked: estimates) ----------
// CJK ≈ 1 token per character, ASCII ≈ 1 token per 4 characters. Real token counts
// require model-side usage, which the vendor chat extension API does not expose, so
// every figure in this report is marked *estimate*.
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2E80 && code <= 0x9FFF) cjk++; // CJK Unified Ideographs and related blocks
    else if (code < 0x80) ascii++;
    else ascii += 2; // other non-ASCII: count conservatively high
  }
  return Math.round(cjk + ascii / 4);
}

// Estimate when only character counts exist (no transcript): ~3 chars ≈ 1 token
// (a rough average over mixed content). Prompt and response are estimated separately
// and then summed, so figures like 5 = P4 + R1 remain checkable.
function charsEst(promptChars, responseChars) {
  const p = Math.round((promptChars || 0) / 3);
  const r = Math.round((responseChars || 0) / 3);
  return { prompt: p, response: r, total: p + r };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return 'n/a';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

const EVENT_LABELS = {
  session_start: '▶ Start recording',
  file_saved: '💾 File saved',
  terminal_cmd: '⌨️ Terminal command',
  model_call: '🤖 Model call (custom participant)',
  transcript: '📄 Transcript snapshot',
  session_end: '■ End recording'
};

// Session "totals": aggregates only observable/estimable items (measured first)
function computeSummary(d) {
  const evs = d.events || [];
  const calls = d.modelCalls || [];
  const ok = calls.filter((c) => c.ok);
  const estOf = (c) => (c.estTokens != null ? c.estTokens : charsEst(c.promptChars || 0, c.responseChars || 0).total);
  return {
    fileSaves: evs.filter((e) => e.type === 'file_saved').length,
    terminalCommands: evs.filter((e) => e.type === 'terminal_cmd').length,
    filesChanged: (d.filesChanged || []).length,
    untracked: (d.untracked || []).length,
    modelCallOk: ok.length,
    modelCallTotal: calls.length,
    avgLatencyMs: ok.length ? Math.round(ok.reduce((s, c) => s + (c.latencyMs || 0), 0) / ok.length) : null,
    modelCallEstTokens: calls.reduce((s, c) => s + estOf(c), 0),
    transcriptEstTokens: (d.transcript && d.transcript.text) ? estimateTokens(d.transcript.text) : null
  };
}

function buildReport(data) {
  const d = data || {};
  const evs = d.events || [];
  const t0 = d.startTs;
  const rows = evs.map((ev) => {
    const offset = t0 ? Math.round((ev.ts - t0) / 1000) : null;
    const label = EVENT_LABELS[ev.type] || ev.type;
    let detail = '';
    switch (ev.type) {
      case 'file_saved':
        detail = `${ev.relPath || '?'}  (${ev.languageId || ''})`;
        break;
      case 'terminal_cmd':
        detail = `${ev.command || '?'}  → exit ${ev.exitCode == null ? '?' : ev.exitCode}`;
        break;
      case 'model_call': {
        const e = (ev.estTokens != null && ev.estPrompt != null)
          ? { total: ev.estTokens, prompt: ev.estPrompt, response: ev.estResp }
          : charsEst(ev.promptChars || 0, ev.responseChars || 0);
        detail = `${ev.participant || '?'}  model=${ev.model || '?'}  ${ev.ok ? 'OK' : 'FAIL'}  ${ev.latencyMs != null ? Math.round(ev.latencyMs) + 'ms' : '?'}  (est ${e.total} tok ≈ P${e.prompt}+R${e.response})`;
        break;
      }
      case 'session_start':
        detail = ev.workspaceRoot || '';
        break;
      case 'session_end':
        detail = `Duration ${fmtDur(d.durationMs)}`;
        break;
      default:
        detail = ev.notes || '';
    }
    return `<tr><td>${offset == null ? '—' : '+' + offset + 's'}</td><td>${label}</td><td>${escapeHtml(detail)}</td></tr>`;
  }).join('\n');

  const fileRows = (d.filesChanged || []).map((f) =>
    `<tr><td>${escapeHtml(f.status)}</td><td>${escapeHtml(f.path)}</td></tr>`
  ).join('\n');

  const untrackedRows = (d.untracked || []).map((p) =>
    `<tr><td>Added (untracked)</td><td>${escapeHtml(p)}</td></tr>`
  ).join('\n');

  const saveRows = Object.entries(d.stats?.savesByExt || {})
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `<tr><td>${escapeHtml(ext || '(no extension)')}</td><td>${n}</td></tr>`)
    .join('\n');

  const modelRows = (d.modelCalls || []).map((m) => {
    const e = (m.estTokens != null && m.estPrompt != null)
      ? { total: m.estTokens, prompt: m.estPrompt, response: m.estResp }
      : charsEst(m.promptChars || 0, m.responseChars || 0);
    return `<tr><td>${escapeHtml(m.participant || '?')}</td><td>${escapeHtml(m.model || '?')}</td>` +
      `<td>${m.ok ? '✅' : '❌'}</td><td>${m.latencyMs != null ? Math.round(m.latencyMs) + 'ms' : '?'}</td>` +
      `<td>${m.promptChars || 0}</td><td>${m.responseChars || 0}</td><td>${e.total} * (≈P${e.prompt}+R${e.response})</td></tr>`;
  }).join('\n');

  const notes = (d.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('\n');

  const S = computeSummary(d);
  const totalsSection = `<h2>Session Totals (everything measurable in this session)</h2>
<table>
<tr><th>Duration</th><td>${fmtDur(d.durationMs)}</td></tr>
<tr><th>File saves</th><td>${S.fileSaves}</td></tr>
<tr><th>Terminal commands</th><td>${S.terminalCommands}</td></tr>
<tr><th>Files changed (git)</th><td>${S.filesChanged}${S.untracked ? ` (+ ${S.untracked} untracked new files)` : ''}</td></tr>
<tr><th>Custom model calls</th><td>${S.modelCallOk} / ${S.modelCallTotal} succeeded${S.avgLatencyMs != null ? `, avg ${S.avgLatencyMs}ms` : ' (none succeeded)'}</td></tr>
<tr><th>Est. tokens from custom calls *</th><td>${S.modelCallEstTokens || 0}</td></tr>
<tr><th>Est. transcript tokens *</th><td>${S.transcriptEstTokens != null ? S.transcriptEstTokens : '(no transcript captured)'}</td></tr>
</table>
<p class="est">* Estimates. Rules: with text (transcript/participant text) → CJK ≈1 token/char, ASCII ≈1 token/4 chars; counts only (custom calls) → ≈3 chars/token (prompt and response estimated separately, then summed). Real token/cost figures for native conversations are not available through the extension API — see the yellow note below.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VSC Chat Trail Audit Report — ${escapeHtml(d.id || '')}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1f2328;line-height:1.55}
  h1{font-size:1.35rem} h2{font-size:1.05rem;border-bottom:1px solid #d0d7de;padding-bottom:.3rem;margin-top:2rem}
  table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.6rem 0}
  th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;vertical-align:top}
  th{background:#f6f8fa} pre{background:#f6f8fa;padding:.8rem;border-radius:6px;overflow:auto;font-size:.8rem}
  .meta td{font-size:.85rem} .warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:.7rem .9rem;font-size:.85rem;margin:.8rem 0}
  .est{color:#57606a;font-size:.75rem} code{background:#eff1f3;border-radius:3px;padding:0 .2rem}
  details{margin:.4rem 0} summary{cursor:pointer;color:#0969da}
</style>
</head>
<body>
<h1>📋 VSC Chat Trail Audit Report <span style="font-weight:400;font-size:.85rem">${escapeHtml(d.generatorVersion || '')}</span></h1>

<h2>Session Metadata</h2>
<table class="meta">
<tr><th style="width:180px">Session ID</th><td><code>${escapeHtml(d.id || '')}</code></td></tr>
<tr><th>Start / End</th><td>${escapeHtml(fmtTime(d.startTs))} → ${escapeHtml(fmtTime(d.endTs))} (${fmtDur(d.durationMs)})</td></tr>
<tr><th>Workspace</th><td>${escapeHtml(d.workspaceFolderName || '(none)')}</td></tr>
<tr><th>Git branch</th><td>${escapeHtml(d.startBranch || '?')} → ${escapeHtml(d.endBranch || '?')}</td></tr>
<tr><th>Git HEAD</th><td><code>${escapeHtml((d.startHead || '').slice(0, 12) || '?')}</code> → <code>${escapeHtml((d.endHead || '').slice(0, 12) || '?')}</code></td></tr>
<tr><th>Git user</th><td>${escapeHtml(d.gitUser || '?')}</td></tr>
${d.tag ? `<tr><th>Task tag</th><td>${escapeHtml(d.tag)}</td></tr>` : ''}
<tr><th>Total events</th><td>${evs.length}</td></tr>
</table>

${totalsSection}

<div class="warn">
<b>What this report cannot show (read this honestly):</b> the vendor chat extension API (e.g. GitHub Copilot) does not expose model internals, per-message tokens/cache hits/cost of native conversations, or agent-mode inner tool-call details to third-party extensions.
This report therefore records <b>observable facts</b>: a timeline (file saves / terminal commands / model calls from custom participants), git changes, and a transcript snapshot.
Token numbers are <b>character-based estimates (*)</b>. Latency and character counts are measured values only when the data comes from a custom participant (marked in the tables).
</div>

<h2>AI Changes Summary (full git diff since session-start HEAD)</h2>
${d.diffStat ? `<pre>${escapeHtml(d.diffStat)}</pre>` : '<p>(no git or no changes)</p>'}
${fileRows || untrackedRows ? `<table><tr><th>Status</th><th>File</th></tr>${fileRows}${untrackedRows}</table>` : ''}

<h2>Timeline (session events)</h2>
${rows ? `<table><tr><th>Relative time</th><th>Event</th><th>Details</th></tr>${rows}</table>` : '<p>(empty)</p>'}
${d.stats && Object.keys(d.stats.savesByExt || {}).length ? `<details><summary>File saves by extension</summary><table><tr><th>Extension</th><th>Count</th></tr>${saveRows}</table></details>` : ''}

<h2>Model Calls by Custom Participants (measured)</h2>
${modelRows ? `<table><tr><th>Participant</th><th>Model</th><th>Result</th><th>Latency</th><th>Prompt chars</th><th>Response chars</th><th>Est. tokens *</th></tr>${modelRows}</table><p class="est">* Token figures are character estimates (rule under "Session Totals"). If vendor usage ever becomes available (once chat model pipelines open up), these will be replaced with real values and the source noted.</p>` : '<p>(No model calls were reported this session. VSC Chat Trail itself never calls a model; measured data appears here only when a future model-calling custom participant reports events via trail.logModelCall.)</p>'}

<h2>Transcript Snapshot</h2>
${d.transcript && d.transcript.text ? `<details open><summary>${escapeHtml(d.transcript.source || '?')} · ${(d.transcript.text || '').length} chars · est. ${estimateTokens(d.transcript.text)} tokens *</summary><pre>${escapeHtml(d.transcript.text)}</pre></details>` : '<p>Could not capture the transcript automatically. Manual option: in the Chat panel, open that conversation\'s menu (⋯) → <b>Export Conversation</b>, save the content to a file — import support is planned.</p>'}

<h2>Known Limitations / Notes</h2>
<ul>
<li>Model chain-of-thought and per-tool inputs/outputs: <b>not available</b> (vendor chat does not expose them to any extension).</li>
<li>Agent-mode steps and checkpoints are visible only in the UI; there is no programmatic outlet yet — not captured in this version.</li>
<li>Which concrete model "auto" routes to: unknowable for native chat conversations; only custom participants can record the model currently selected in the dropdown.</li>
<li>File-save / terminal-command events rely on VS Code events and terminal Shell Integration; terminal sessions without integration are not recorded.</li>
<li>Estimate rules: (1) with text (transcript/participant text): CJK ≈1 token per char, ASCII ≈1 token per 4 chars, other chars ≈1 token per 2 chars; (2) counts only (custom calls): ≈3 chars per token (prompt and response estimated separately, then summed). All estimates are marked *.</li>
${notes ? `<li>Other notes:</li>${notes}` : ''}
</ul>

<p class="est">Generated: ${escapeHtml(fmtTime(Date.now()))} | schemaVersion=${escapeHtml(d.schemaVersion || '?')}</p>
</body>
</html>`;
}

// JSON sidecar: same data as the HTML report, for future scripts doing session/skill/
// workflow-level aggregation.
function buildJsonReport(data) {
  return JSON.stringify({
    generator: data.generatorVersion,
    schemaVersion: data.schemaVersion,
    id: data.id,
    startTs: data.startTs,
    endTs: data.endTs,
    durationMs: data.durationMs,
    workspaceFolderName: data.workspaceFolderName,
    branch: { start: data.startBranch, end: data.endBranch },
    head: { start: data.startHead, end: data.endHead },
    gitUser: data.gitUser,
    tag: data.tag || null,
    summary: computeSummary(data),
    diffStat: data.diffStat,
    filesChanged: data.filesChanged || [],
    untracked: data.untracked || [],
    modelCalls: (data.modelCalls || []).map((m) => ({ ...m, estTokens: m.estTokens })),
    transcript: data.transcript
      ? { source: data.transcript.source, textLength: (data.transcript.text || '').length, estTokens: estimateTokens(data.transcript.text) }
      : null,
    events: (data.events || []).map((ev) => ({ ...ev })),
    stats: data.stats || {}
  }, null, 2);
}

module.exports = { buildReport, buildJsonReport, estimateTokens, charsEst, computeSummary, escapeHtml, fmtTime, fmtDur };
