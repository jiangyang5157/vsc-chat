// report-builder.js —— 纯函数：把一次 trail 会话的数据渲染成 HTML 审计报告 / JSON
// 不依赖 vscode，可单独用 node 测试。
'use strict';

// ---------- token 估算（明确标注：估算值） ----------
// CJK 每字符 ~1 token，ASCII 约 4 字符 = 1 token。真实 token 数需模型侧 usage，
// 厂商 chat 扩展 API 不暴露 usage，本报告一律标 *估算*。
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2E80 && code <= 0x9FFF) cjk++; // 中日韩统一表意区等
    else if (code < 0x80) ascii++;
    else ascii += 2; // 其他非 ASCII 按偏大估算
  }
  return Math.round(cjk + ascii / 4);
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
  if (ms == null || isNaN(ms)) return '(未记录)';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

const EVENT_LABELS = {
  session_start: '▶ 开始录制',
  file_saved: '💾 文件保存',
  terminal_cmd: '⌨️ 终端命令',
  model_call: '🤖 模型调用(自研参与者)',
  transcript: '📄 会话原文快照',
  session_end: '■ 结束录制'
};

// 会话"总量"汇总：只汇总可观测/可估算项（实测为主）
function computeSummary(d) {
  const evs = d.events || [];
  const calls = d.modelCalls || [];
  const ok = calls.filter((c) => c.ok);
  const estOf = (c) => (c.estTokens != null ? c.estTokens : Math.round(((c.promptChars || 0) + (c.responseChars || 0)) / 3));
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
      case 'model_call':
        detail = `${ev.participant || '?'}  model=${ev.model || '?'}  ${ev.ok ? 'OK' : 'FAIL'}  ${ev.latencyMs != null ? Math.round(ev.latencyMs) + 'ms' : '?'}  (估算 ${ev.estTokens || '?'} tok)`;
        break;
      case 'session_start':
        detail = ev.workspaceRoot || '';
        break;
      case 'session_end':
        detail = `时长 ${fmtDur(d.durationMs)}`;
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
    `<tr><td>新增(未跟踪)</td><td>${escapeHtml(p)}</td></tr>`
  ).join('\n');

  const saveRows = Object.entries(d.stats?.savesByExt || {})
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `<tr><td>${escapeHtml(ext || '(无扩展名)')}</td><td>${n}</td></tr>`)
    .join('\n');

  const modelRows = (d.modelCalls || []).map((m) => {
    const est = m.estTokens != null ? m.estTokens : Math.round(((m.promptChars || 0) + (m.responseChars || 0)) / 3);
    return `<tr><td>${escapeHtml(m.participant || '?')}</td><td>${escapeHtml(m.model || '?')}</td>` +
      `<td>${m.ok ? '✅' : '❌'}</td><td>${m.latencyMs != null ? Math.round(m.latencyMs) + 'ms' : '?'}</td>` +
      `<td>${m.promptChars || 0}</td><td>${m.responseChars || 0}</td><td>${est} *</td></tr>`;
  }).join('\n');

  const notes = (d.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('\n');

  const S = computeSummary(d);
  const totalsSection = `<h2>本次会话汇总（能算的总量都在这里）</h2>
<table>
<tr><th>录制时长</th><td>${fmtDur(d.durationMs)}</td></tr>
<tr><th>文件保存次数</th><td>${S.fileSaves}</td></tr>
<tr><th>终端命令次数</th><td>${S.terminalCommands}</td></tr>
<tr><th>git 变更文件数</th><td>${S.filesChanged}${S.untracked ? `（另有 ${S.untracked} 个未跟踪新文件）` : ''}</td></tr>
<tr><th>自研模型调用</th><td>${S.modelCallOk} / ${S.modelCallTotal} 成功${S.avgLatencyMs != null ? `，平均耗时 ${S.avgLatencyMs}ms` : '（没有成功调用）'}</td></tr>
<tr><th>自研调用估算 token 合计 *</th><td>${S.modelCallEstTokens || 0}</td></tr>
<tr><th>会话原文估算 token *</th><td>${S.transcriptEstTokens != null ? S.transcriptEstTokens : '（未抓到会话原文）'}</td></tr>
</table>
<p class="est">* 估算值。原生对话的真实 token/成本无法从扩展 API 取得（厂商 chat 不开放），见下方黄色限制说明。</p>`;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>VSC Chat Trail 审计报告 — ${escapeHtml(d.id || '')}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1f2328;line-height:1.55}
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
<h1>📋 VSC Chat Trail 审计报告 <span style="font-weight:400;font-size:.85rem">${escapeHtml(d.generatorVersion || '')}</span></h1>

<h2>会话元信息</h2>
<table class="meta">
<tr><th style="width:180px">会话 ID</th><td><code>${escapeHtml(d.id || '')}</code></td></tr>
<tr><th>开始 / 结束</th><td>${escapeHtml(fmtTime(d.startTs))} → ${escapeHtml(fmtTime(d.endTs))}（${fmtDur(d.durationMs)}）</td></tr>
<tr><th>工作区</th><td>${escapeHtml(d.workspaceFolderName || '(无)')}</td></tr>
<tr><th>Git 分支</th><td>${escapeHtml(d.startBranch || '?')} → ${escapeHtml(d.endBranch || '?')}</td></tr>
<tr><th>Git HEAD</th><td><code>${escapeHtml((d.startHead || '').slice(0, 12) || '?')}</code> → <code>${escapeHtml((d.endHead || '').slice(0, 12) || '?')}</code></td></tr>
<tr><th>Git 用户</th><td>${escapeHtml(d.gitUser || '?')}</td></tr>
${d.tag ? `<tr><th>任务标签</th><td>${escapeHtml(d.tag)}</td></tr>` : ''}
<tr><th>事件总数</th><td>${evs.length}</td></tr>
</table>

${totalsSection}

<div class="warn">
<b>本报告的限制（请如实理解）：</b>当前厂商 chat（GitHub Copilot）的扩展 API 不向第三方暴露模型内部推理、原生对话的逐条 token/缓存命中/成本、以及 agent mode 内部工具调用明细。
因此本报告记录的是 <b>可观测事实</b>：时间线（文件保存/终端命令/自研参与者模型调用）、git 变更、会话原文快照；
token 数字为<b>字符数估算（*）</b>。当数据来自自研参与者时（表中有“自研参与者”标记），耗时与字符为实测值。
</div>

<h2>AI 变更摘要（git 自开始 HEAD 起的全部差异）</h2>
${d.diffStat ? `<pre>${escapeHtml(d.diffStat)}</pre>` : '<p>(无 git 或没有差异)</p>'}
${fileRows || untrackedRows ? `<table><tr><th>状态</th><th>文件</th></tr>${fileRows}${untrackedRows}</table>` : ''}

<h2>时间线（会话事件）</h2>
${rows ? `<table><tr><th>相对时间</th><th>事件</th><th>详情</th></tr>${rows}</table>` : '<p>(空)</p>'}
${d.stats && Object.keys(d.stats.savesByExt || {}).length ? `<details><summary>按扩展名统计的文件保存次数</summary><table><tr><th>扩展名</th><th>次数</th></tr>${saveRows}</table></details>` : ''}

<h2>自研参与者模型调用（实测）</h2>
${modelRows ? `<table><tr><th>参与者</th><th>模型</th><th>结果</th><th>耗时</th><th>prompt 字符</th><th>响应字符</th><th>估算 token *</th></tr>${modelRows}</table><p class="est">* token 为字符估算。将来若拿到模型 usage（我们自己的参与者走 Copilot 模型管道时），将替换为真实值并注明来源。</p>` : '<p>(本次会话没有自研参与者发起过模型调用——用 @probe/@asb-runbook 等自研参与者并在录制期间使用，这里才会有数据。)</p>'}

<h2>会话原文快照</h2>
${d.transcript && d.transcript.text ? `<details open><summary>${escapeHtml(d.transcript.source || '?')} · ${(d.transcript.text || '').length} 字符 · 估算 ${estimateTokens(d.transcript.text)} token *</summary><pre>${escapeHtml(d.transcript.text)}</pre></details>` : '<p>未能自动抓取会话原文。手动方式：在 Chat 面板该会话的菜单(⋯)里选 <b>Export Conversation</b> 导出，再把内容存成文件——后续版本支持导入。</p>'}

<h2>过程说明 / 已知局限</h2>
<ul>
<li>模型内部思维链、逐工具调用的输入输出：<b>不可得</b>（Copilot 不提供，任何扩展都拿不到）。</li>
<li>agent mode 的步骤与 checkpoints 只在界面上可见，暂无程序化出口——本版本未采集。</li>
<li>auto 模型实际路由到哪个模型：对原生 Copilot 对话不可知；仅当使用自研参与者时可记录下拉框当前选择。</li>
<li>文件保存/终端命令事件：依赖 VS Code 事件与终端 Shell Integration，未接入的终端会话不会被记录。</li>
<li>估算公式：CJK 每字 ~1 token，ASCII ~4 字符/token。</li>
${notes ? `<li>其他说明：</li>${notes}` : ''}
</ul>

<p class="est">生成时间：${escapeHtml(fmtTime(Date.now()))} ｜ schemaVersion=${escapeHtml(d.schemaVersion || '?')}</p>
</body>
</html>`;
}

// JSON 侧车文件：与 HTML 同一份数据，供将来写脚本做会话/技能/流程维度的聚合分析
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

module.exports = { buildReport, buildJsonReport, estimateTokens, computeSummary, escapeHtml, fmtTime, fmtDur };
