// trail.js —— 会话轨迹记录器（v0.2 简易版）
//
// 设计目标：像"录像机"一样记录一次 AI 协作会话的可观测事实，结束时导出 HTML 审计报告。
// 记录什么（全部是扩展 API 拿得到的"世界变化"）：
//   - git：开始/结束时的分支与 HEAD、期间的全部差异(stat + 文件清单)、未跟踪新文件
//   - 时间线事件：文件保存、终端命令(Shell Integration)、自研参与者发起的模型调用(实测耗时/字符)
//   - 会话原文快照：尝试用官方 Export Conversation 命令抓取当前会话
// 刻意不造假：厂商 chat（如 GitHub Copilot）不向扩展暴露 token/cache/成本/思维链，本版本 token 为字符估算。
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildReport, buildJsonReport, estimateTokens, charsEst, fmtDur } = require('./report-builder');

const execFileP = promisify(execFile);

// 供其他模块(如自研参与者)在录制进行中追加 model_call 事件
let activeRecorder = null;
function logModelCall(partial) {
  if (activeRecorder) activeRecorder.add(Object.assign({ type: 'model_call' }, partial));
}

async function runGit(args, cwd) {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 20000 });
  return stdout;
}

function registerTrail(context, out) {
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'vscChat.finish';
  statusItem.tooltip = 'VSC Chat Trail：结束并导出审计报告';
  context.subscriptions.push(statusItem);

  const startCmd = vscode.commands.registerCommand('vscChat.start', async () => {
    if (activeRecorder) {
      vscode.window.showInformationMessage('VSC Chat Trail：已经在录制中（会话 ' + activeRecorder.id + '）。要结束请运行 “VSC Chat Trail: ■ 结束并导出” 或点状态栏。');
      return;
    }
    const tag = await vscode.window.showInputBox({
      prompt: '(可选) 给本次会话一个标签，便于以后按任务/技能聚合分析，例如 STORY-1234 / review / 修bug；直接回车跳过',
      ignoreFocusOut: true
    });
    const rec = await Recorder.start(context, out, (tag || '').trim() || null);
    if (!rec) return;
    activeRecorder = rec;
    statusItem.text = '$(record-keys) VSC Chat Trail 录制中…';
    statusItem.show();
    vscode.window.showInformationMessage(`VSC Chat Trail：开始录制（会话 ${rec.id}）。做完 AI 协作后运行 “VSC Chat Trail: ■ 结束并导出 HTML 审计报告”。`);
  });

  const finishCmd = vscode.commands.registerCommand('vscChat.finish', async () => {
    if (!activeRecorder) {
      vscode.window.showWarningMessage('VSC Chat Trail：当前没有正在录制的会话。请先运行 “VSC Chat Trail: ▶ 开始记录会话”。');
      return;
    }
    const rec = activeRecorder;
    activeRecorder = null;
    statusItem.hide();
    const result = await rec.finishAndExport();
    if (result && result.htmlPath) {
      vscode.window.showInformationMessage(`VSC Chat Trail：审计报告已生成 → ${result.htmlPath}`);
      try { await vscode.env.openExternal(vscode.Uri.file(result.htmlPath)); } catch (e) { out.appendLine('[trail] 打开报告失败: ' + (e && e.message)); }
    }
  });

  context.subscriptions.push(startCmd, finishCmd);
  out.appendLine('[register] VSC Chat Trail 命令已注册（start / finish）');
}

// ---------------------------------------------------------------
class Recorder {
  constructor(context, out, opts) {
    this.context = context;
    this.out = out;
    this.id = opts.id;
    this.root = opts.root; // workspace 根(可能 null)
    this.startTs = Date.now();
    this.startHead = opts.startHead;
    this.startBranch = opts.startBranch;
    this.gitUser = opts.gitUser;
    this.events = [];
    this.disposables = [];
    this.logStream = null;
    this.outputDir = opts.outputDir;
    this.logPath = opts.logPath;
    this.tag = opts.tag || null;
  }

  add(ev) {
    ev.ts = ev.ts || Date.now();
    if (ev.type === 'model_call' && ev.estTokens == null) {
      // 无原文时按 3 字符≈1 token 估（P/R 分开估后相加），报告会标注 *
      const e = charsEst(ev.promptChars || 0, ev.responseChars || 0);
      ev.estTokens = e.total;
      ev.estPrompt = e.prompt;
      ev.estResp = e.response;
    }
    this.events.push(ev);
    if (this.logStream) {
      try { this.logStream.write(JSON.stringify(ev) + '\n'); } catch (e) { this.out.appendLine('[trail] 写日志失败: ' + (e && e.message)); }
    }
  }

  async finishAndExport() {
    const endTs = Date.now();
    const out = this.out;

    // 1) 结束状态：分支 / HEAD / git 用户
    let endBranch = null;
    let endHead = null;
    if (this.root) {
      try { endBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.root)).trim() || null; } catch (e) { out.appendLine('[trail] 读取分支失败: ' + (e && e.message)); }
      try { endHead = (await runGit(['rev-parse', 'HEAD'], this.root)).trim() || null; } catch (e) { /* 无提交 */ }
    }

    // 2) 停止监听
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* noop */ } }
    this.disposables = [];
    if (this.logStream) { try { this.logStream.end(); } catch (e) { /* noop */ } this.logStream = null; }

    this.add({ type: 'session_end', notes: '录制结束', head: endHead, branch: endBranch });

    // 3) git 差异（相对开始 HEAD：含期间提交 + 未提交改动）
    let diffStat = null;
    const filesChanged = [];
    let untracked = [];
    if (this.root && this.startHead) {
      try {
        diffStat = await runGit(['diff', this.startHead, '--stat', '--no-color'], this.root);
        const nameStatus = await runGit(['diff', this.startHead, '--name-status', '--no-color'], this.root);
        for (const line of nameStatus.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length >= 2) filesChanged.push({ status: parts[0], path: parts[parts.length - 1] });
        }
        const others = await runGit(['ls-files', '--others', '--exclude-standard'], this.root);
        const outRel = path.relative(this.root, this.outputDir);
        untracked = others.split('\n').map((s) => s.trim()).filter(Boolean)
          .filter((p) => !(outRel && (p === outRel || p.startsWith(outRel + path.sep))));
      } catch (e) { out.appendLine('[trail] git 差异读取失败: ' + (e && e.message)); }
    }

    // 4) 抓会话原文（官方 Export Conversation 命令，失败不阻断）
    const transcript = await tryExportTranscript(out);

    // 5) 统计
    const savesByExt = {};
    for (const ev of this.events) {
      if (ev.type === 'file_saved') {
        const key = ev.ext || '';
        savesByExt[key] = (savesByExt[key] || 0) + 1;
      }
    }
    const modelCalls = this.events.filter((e) => e.type === 'model_call').map((e) => e);
    const commandCount = this.events.filter((e) => e.type === 'terminal_cmd').length;

    const data = {
      generatorVersion: 'vsc-chat-trail v0.2.1',
      schemaVersion: 'trail-jsonl-1',
      id: this.id,
      startTs: this.startTs,
      endTs,
      durationMs: endTs - this.startTs,
      workspaceFolderName: this.root ? path.basename(this.root) : '(无工作区)',
      startBranch: this.startBranch,
      endBranch,
      startHead: this.startHead,
      endHead,
      gitUser: this.gitUser,
      tag: this.tag || null,
      diffStat: diffStat && diffStat.trim() ? diffStat : null,
      filesChanged,
      untracked,
      modelCalls,
      transcript,
      events: this.events,
      stats: { savesByExt, commandCount },
      notes: []
    };

    // 6) 写 HTML + JSON
    const tsName = new Date(endTs).toISOString().replace(/[:.]/g, '-');
    const reportDir = path.join(this.outputDir, 'reports');
    try { fs.mkdirSync(reportDir, { recursive: true }); } catch (e) { out.appendLine('[trail] 建目录失败: ' + (e && e.message)); }
    const htmlPath = path.join(reportDir, `${this.id}-${tsName}.html`);
    const jsonPath = path.join(reportDir, `${this.id}-${tsName}.json`);
    try {
      fs.writeFileSync(htmlPath, buildReport(data), 'utf8');
      fs.writeFileSync(jsonPath, buildJsonReport(data), 'utf8');
      out.appendLine(`[trail] 报告已生成:\n  HTML ${htmlPath}\n  JSON ${jsonPath}`);
      return { htmlPath, jsonPath };
    } catch (e) {
      out.appendLine('[trail] 写报告失败: ' + (e && e.stack || e && e.message));
      vscode.window.showErrorMessage('VSC Chat Trail：报告写入失败 ' + (e && e.message));
      return null;
    }
  }

  static async start(context, out, tag) {
    const folders = vscode.workspace.workspaceFolders || [];
    const root = folders.length ? folders[0].uri.fsPath : null;

    // 输出目录：默认工作区下 .vsc-chat-trail；没有工作区则用扩展全局存储
    const cfgDir = vscode.workspace.getConfiguration('vscChat').get('outputDir', '.vsc-chat-trail');
    const outputDir = root ? path.join(root, cfgDir) : path.join(context.globalStorageUri.fsPath, 'trail');
    try { fs.mkdirSync(path.join(outputDir, 'sessions'), { recursive: true }); } catch (e) { out.appendLine('[trail] 建目录失败: ' + (e && e.message)); }

    // git 初始状态
    let startHead = null;
    let startBranch = null;
    let gitUser = null;
    if (root) {
      try { startHead = (await runGit(['rev-parse', 'HEAD'], root)).trim() || null; } catch (e) { out.appendLine('[trail] 无 HEAD(可能是空仓库): ' + (e && e.message)); }
      try { startBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim() || null; } catch (e) { /* noop */ }
      try {
        const name = (await runGit(['config', 'user.name'], root)).trim();
        const email = (await runGit(['config', 'user.email'], root)).trim();
        gitUser = `${name} <${email}>`;
      } catch (e) { /* noop */ }
    }

    const id = crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
    const logPath = path.join(outputDir, 'sessions', `${id}.jsonl`);
    const rec = new Recorder(context, out, { id, root, startHead, startBranch, gitUser, outputDir, logPath, tag: tag || null });
    rec.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    rec.add({ type: 'session_start', workspaceRoot: root || null, branch: startBranch, head: startHead, tag: rec.tag });

    // 监听文件保存
    rec.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!doc || doc.uri.scheme !== 'file') return;
      const rel = root ? path.relative(root, doc.uri.fsPath) : doc.uri.fsPath;
      if (rel.startsWith('.git')) return;
      const ext = path.extname(doc.uri.fsPath).toLowerCase();
      rec.add({ type: 'file_saved', relPath: rel, languageId: doc.languageId, ext });
    }));

    // 监听终端命令结束（Shell Integration；老版本无此 API 则跳过）
    const onEnd = vscode.window.onDidEndTerminalShellExecution;
    if (typeof onEnd === 'function') {
      rec.disposables.push(onEnd((e) => {
        const cl = e && e.execution && e.execution.commandLine;
        const cmd = typeof cl === 'string' ? cl : (cl && cl.value) || '';
        rec.add({ type: 'terminal_cmd', command: String(cmd).slice(0, 1000), exitCode: e.exitCode == null ? null : e.exitCode });
      }));
    }

    return rec;
  }
}

// 尝试用官方导出命令抓当前会话原文。命令 ID 各版本略有差异，逐个试。
async function tryExportTranscript(out) {
  const candidates = [
    'workbench.action.chat.export',
    'workbench.action.chat.exportConversation',
    'github.copilot.chat.exportConversation'
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const id of candidates) {
    try {
      const before = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.toString() : null;
      await vscode.commands.executeCommand(id);
      await sleep(600);
      const ed = vscode.window.activeTextEditor;
      if (!ed || !ed.document) continue;
      const uri = ed.document.uri.toString();
      if (before && uri === before) continue; // 没产生新编辑器
      const text = ed.document.getText();
      if (text && text.trim().length > 0) {
        // 若是我们触发的 untitled 文档，读完后关掉，避免打扰用户
        if (ed.document.uri.scheme === 'untitled') {
          try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch (e) { /* noop */ }
        }
        out.appendLine(`[trail] 会话原文抓取成功(source=${id}, ${text.length} 字符)`);
        return { source: id, text };
      }
    } catch (e) { /* 该命令不可用，试下一个 */ }
  }
  out.appendLine('[trail] 未能自动抓取会话原文(所有导出命令均不可用或无可导出会话)');
  return null;
}

module.exports = { registerTrail, logModelCall, Recorder, fmtDur };
