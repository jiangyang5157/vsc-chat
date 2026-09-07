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
  editor_activity: '📌 Active file',
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
    transcriptEstTokens: (d.transcript && d.transcript.text) ? estimateTokens(d.transcript.text) : null,
    charsAdded: (d.editStats && typeof d.editStats.totalAdded === 'number') ? d.editStats.totalAdded : null,
    charsRemoved: (d.editStats && typeof d.editStats.totalRemoved === 'number') ? d.editStats.totalRemoved : null,
    commits: (d.commitsMade || []).length,
    terminalDurationMs: evs
      .filter((e) => e.type === 'terminal_cmd' && typeof e.durationMs === 'number')
      .reduce((s, e) => s + e.durationMs, 0) || null
  };
}

// --- session narrative (activity segments) ---
// Turns the raw event list into readable activity bursts: events separated by less than
// IDLE_GAP_MS belong to one continuous work window and are merged into a segment with
// aggregated facts. The raw rows stay available in the "Raw Event Timeline" <details>.
const IDLE_GAP_MS = 10 * 60 * 1000;
const SEGMENT_TYPES = new Set(['file_saved', 'terminal_cmd', 'model_call', 'editor_activity']);

function fmtOffset(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function buildSegments(events) {
  const work = (events || [])
    .filter((e) => SEGMENT_TYPES.has(e.type))
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (work.length === 0) return [];
  const segs = [];
  let cur = null;
  for (const ev of work) {
    const ts = ev.ts || 0;
    if (!cur || ts - cur.end > IDLE_GAP_MS) {
      if (cur) segs.push(cur);
      cur = { start: ts, end: ts, saves: 0, terminals: [], calls: 0, editorSwitches: 0, files: new Set() };
    }
    cur.end = Math.max(cur.end, ts);
    if (ev.type === 'file_saved') cur.saves++;
    else if (ev.type === 'terminal_cmd') cur.terminals.push(ev);
    else if (ev.type === 'model_call') cur.calls++;
    else if (ev.type === 'editor_activity') cur.editorSwitches++;
    if (ev.relPath) cur.files.add(ev.relPath);
  }
  segs.push(cur);
  return segs.map((s) => ({
    start: s.start,
    end: s.end,
    saves: s.saves,
    terminalCount: s.terminals.length,
    terminalDetail: s.terminals.slice(0, 3).map((c) => String(c.command || '?').slice(0, 90)).join(' | '),
    calls: s.calls,
    editorSwitches: s.editorSwitches,
    files: Array.from(s.files).slice(0, 4),
    moreFiles: Math.max(0, s.files.size - 4)
  }));
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
        detail = `${ev.command || '?'}  → exit ${ev.exitCode == null ? '?' : ev.exitCode}` +
          (typeof ev.durationMs === 'number' ? `  (${fmtDur(ev.durationMs)})` : '');
        break;
      case 'editor_activity':
        detail = `${ev.relPath || '?'}  (${ev.languageId || ''})`;
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

  const commitRows = (d.commitsMade || []).map((c) =>
    `<tr><td>${escapeHtml(fmtTime(new Date(c.date).getTime()))}</td><td><code>${escapeHtml(String(c.hash || '').slice(0, 8))}</code></td><td>${escapeHtml(c.subject || '')}</td></tr>`
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
  const segments = buildSegments(d.events);
  const editFileRows = (() => {
    const files = (d.editStats && d.editStats.files) || {};
    return Object.keys(files)
      .sort((a, b) => (files[b].added + files[b].removed) - (files[a].added + files[a].removed))
      .map((rel) => `<tr><td>${escapeHtml(rel)}</td><td>${files[rel].added}</td><td>${files[rel].removed}</td><td>${(files[rel].added - files[rel].removed) >= 0 ? '+' : ''}${files[rel].added - files[rel].removed}</td></tr>`)
      .join('\n');
  })();
  const narrativeHtml = segments.length ? '<h2>Session Narrative (activity segments)</h2>' + segments.map((seg, i) => {
    const idle = i > 0 ? seg.start - segments[i - 1].end : null;
    const facts = [];
    if (seg.files.length) facts.push(`files: ${seg.files.map(escapeHtml).join(', ')}${seg.moreFiles ? ` +${seg.moreFiles} more` : ''}`);
    if (seg.saves) facts.push(`${seg.saves} file save${seg.saves > 1 ? 's' : ''}`);
    if (seg.terminalCount) facts.push(`${seg.terminalCount} terminal command${seg.terminalCount > 1 ? 's' : ''}${seg.terminalDetail ? ` — ${escapeHtml(seg.terminalDetail)}` : ''}`);
    if (seg.calls) facts.push(`${seg.calls} custom model call${seg.calls > 1 ? 's' : ''}`);
    if (seg.editorSwitches) facts.push(`${seg.editorSwitches} editor switch${seg.editorSwitches > 1 ? 'es' : ''}`);
    if (!facts.length) facts.push('no recorded events in this segment');
    const idleNote = idle != null && idle >= IDLE_GAP_MS ? `<p class="gap">… idle ${fmtDur(idle)} before this segment …</p>` : '';
    return `${idleNote}<h3>▲ ${fmtOffset(seg.start - d.startTs)} → ${fmtOffset(seg.end - d.startTs)} (${fmtDur(seg.end - seg.start)})</h3><p class="seg">${facts.join(' · ')}</p>`;
  }).join('\n') : '';
  const showModelCalls = S.modelCallTotal > 0;
  const showTranscriptTokens = S.transcriptEstTokens != null;
  const totalsSection = `<h2>Session Totals (everything measurable in this session)</h2>
<table>
<tr><th>Duration</th><td>${fmtDur(d.durationMs)}</td></tr>
<tr><th>File saves</th><td>${S.fileSaves}</td></tr>
<tr><th>Terminal commands</th><td>${S.terminalCommands}${S.terminalDurationMs != null ? ` (total ${fmtDur(S.terminalDurationMs)})` : ''}</td></tr>
<tr><th>Files changed (git)</th><td>${S.filesChanged}${S.untracked ? ` (+ ${S.untracked} untracked new files)` : ''}</td></tr>
<tr><th>Text edits (chars added / removed)</th><td>${S.charsAdded == null ? '(not measured)' : `${S.charsAdded} / ${S.charsRemoved}`}</td></tr>
<tr><th>Commits made during session</th><td>${S.commits}</td></tr>
${showModelCalls ? `<tr><th>Custom model calls</th><td>${S.modelCallOk} / ${S.modelCallTotal} succeeded${S.avgLatencyMs != null ? `, avg ${S.avgLatencyMs}ms` : ' (none succeeded)'}</td></tr>` : ''}
${showTranscriptTokens ? `<tr><th>Est. transcript tokens *</th><td>${S.transcriptEstTokens}</td></tr>` : ''}
</table>
${showModelCalls || showTranscriptTokens ? `<p class="est">* Estimates: transcript tokens are character-based (CJK ≈1 token/char, ASCII ≈1 token/4 chars); custom-call tokens (≈3 chars/token) appear only when a custom participant reports calls. Real token/cost figures for native conversations are not available through the extension API.</p>` : ''}`;

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
  h3{font-size:.95rem;margin:1.1rem 0 .15rem} p.seg{margin:0 0 .4rem;font-size:.85rem;color:#1f2328}
  p.gap{color:#57606a;font-size:.8rem;font-style:italic;margin:.5rem 0 .1rem}
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

${narrativeHtml}

${editFileRows ? `<h2>Text Edits by File (chars, whole session)</h2>
<table><tr><th>File</th><th>Added</th><th>Removed</th><th>Net</th></tr>${editFileRows}</table>` : ''}

<h2>AI Changes Summary (full git diff since session-start HEAD)</h2>
${d.diffStat ? `<pre>${escapeHtml(d.diffStat)}</pre>` : '<p>(no git or no changes)</p>'}
${fileRows || untrackedRows ? `<table><tr><th>Status</th><th>File</th></tr>${fileRows}${untrackedRows}</table>` : ''}

<h2>Commits Made During Session</h2>
${d.commitsMade == null ? '' : (commitRows ? `<table><tr><th>Time</th><th>Commit</th><th>Message</th></tr>${commitRows}</table>` : '<p>(no commits during the session)</p>')}

<h2>Raw Event Timeline</h2>
<details>
<summary>Show all ${evs.length} raw events (audit view)</summary>
${rows ? `<table><tr><th>Relative time</th><th>Event</th><th>Details</th></tr>${rows}</table>` : '<p>(empty)</p>'}
${d.stats && Object.keys(d.stats.savesByExt || {}).length ? `<details><summary>File saves by extension</summary><table><tr><th>Extension</th><th>Count</th></tr>${saveRows}</table></details>` : ''}
</details>

${modelRows ? `<h2>Model Calls by Custom Participants (measured)</h2>
<table><tr><th>Participant</th><th>Model</th><th>Result</th><th>Latency</th><th>Prompt chars</th><th>Response chars</th><th>Est. tokens *</th></tr>${modelRows}</table><p class="est">* Token figures are character estimates (see rules under "Session Totals"). Real vendor usage is not exposed to extensions; these will be replaced with measured values if it ever becomes available.</p>` : ''}

<h2>Transcript Snapshot</h2>
${d.transcript && d.transcript.text ? `<details open><summary>${escapeHtml(d.transcript.source || '?')} · ${(d.transcript.text || '').length} chars · est. ${estimateTokens(d.transcript.text)} tokens *</summary><pre>${escapeHtml(d.transcript.text)}</pre></details>` : '<p>No transcript was captured when the session stopped. To include one, keep the conversation open in the Chat panel of the recording window and use <b>Export Conversation</b> (conversation menu ⋯) before stopping.</p>'}

<details>
<summary><b>Known limitations / notes (why some data is missing)</b></summary>
<ul>
<li>Model chain-of-thought and per-tool inputs/outputs: <b>not available</b> (vendor chat does not expose them to any extension).</li>
<li>Agent-mode steps and checkpoints are visible only in the UI; there is no programmatic outlet yet — not captured in this version.</li>
<li>Which concrete model "auto" routes to: unknowable for native chat conversations; only custom participants can record the model currently selected in the dropdown.</li>
<li>File-save / terminal-command events rely on VS Code events and terminal Shell Integration; terminal sessions without integration are not recorded.</li>
<li>Text-edit stats count editor changes only; they are a proxy for "output kept" and can differ from the final git diff (e.g. formatting round-trips, reverts).</li>
<li>Terminal duration comes from shell-integration execution timing; terminal output volume is not exposed by the API.</li>
${notes ? `<li>Other notes:</li>${notes}` : ''}
</ul>
</details>

<p class="est">Generated: ${escapeHtml(fmtTime(Date.now()))} | schemaVersion=${escapeHtml(d.schemaVersion || '?')}</p>
</body>
</html>`;
}

// JSON sidecar: same data as the artifact, for future scripts doing session/skill/
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
    editStats: data.editStats || null,
    commitsMade: data.commitsMade == null ? null : data.commitsMade,
    modelCalls: (data.modelCalls || []).map((m) => ({ ...m, estTokens: m.estTokens })),
    transcript: data.transcript
      ? { source: data.transcript.source, textLength: (data.transcript.text || '').length, estTokens: estimateTokens(data.transcript.text) }
      : null,
    events: (data.events || []).map((ev) => ({ ...ev })),
    stats: data.stats || {}
  }, null, 2);
}

module.exports = { buildReport, buildJsonReport, estimateTokens, charsEst, computeSummary, escapeHtml, fmtTime, fmtDur };
