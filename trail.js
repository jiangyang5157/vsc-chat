// trail.js — session recorder (v0.3)
//
// Design goal: act like a "recorder" for one AI collaboration session, capturing the
// observable facts the extension API can see, and exporting an HTML audit report at the end.
// What is recorded (all "world changes" available to the extension API):
//   - git: branch and HEAD at start/end, the full diff since the start HEAD (stat + file
//     list), and untracked new files
//   - timeline events: file saves, terminal commands (Shell Integration), and model calls
//     made by custom participants via logModelCall (measured latency/chars)
//   - transcript snapshot: tries the official Export Conversation command to capture the
//     current session
// We never fabricate data: vendor chat (e.g. GitHub Copilot) does not expose tokens/cache/
// cost/chain-of-thought to extensions, so token figures in this version are character-based
// estimates.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildReport, buildJsonReport, charsEst } = require('./report-builder');

const execFileP = promisify(execFile);

// Lets other modules (e.g. custom chat participants) append model_call events while a
// recording is in progress.
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
  statusItem.command = 'vscChatTrail.finish';
  statusItem.tooltip = 'VSC Chat Trail: Stop session and export artifact';
  context.subscriptions.push(statusItem);

  const startCmd = vscode.commands.registerCommand('vscChatTrail.start', async () => {
    if (activeRecorder) {
      vscode.window.showInformationMessage(`VSC Chat Trail: already recording (session ${activeRecorder.id}). Run "VSC Chat Trail: ■ Stop session and export artifact" or click the status bar item to finish.`);
      return;
    }
    const tag = await vscode.window.showInputBox({
      prompt: '(optional) Tag this session for later per-task/skill aggregation, e.g. STORY-1234 / review / fix-bug. Press Enter to skip.',
      ignoreFocusOut: true
    });
    const rec = await Recorder.start(context, out, (tag || '').trim() || null);
    if (!rec) return;
    activeRecorder = rec;
    statusItem.text = '$(record-keys) VSC Chat Trail recording…';
    statusItem.show();
    vscode.window.showInformationMessage(`VSC Chat Trail: recording started (session ${rec.id}). Run "VSC Chat Trail: ■ Stop session and export artifact" after the AI collaboration.`);
  });

  const finishCmd = vscode.commands.registerCommand('vscChatTrail.finish', async () => {
    if (!activeRecorder) {
      vscode.window.showWarningMessage('VSC Chat Trail: no session is currently being recorded. Run "VSC Chat Trail: ▶ Start session" first.');
      return;
    }
    const rec = activeRecorder;
    activeRecorder = null;
    statusItem.hide();
    const result = await rec.finishAndExport();
    if (result && result.htmlPath) {
      vscode.window.showInformationMessage(`VSC Chat Trail: audit report generated → ${result.htmlPath}`);
      try { await vscode.env.openExternal(vscode.Uri.file(result.htmlPath)); } catch (e) { out.appendLine('[trail] failed to open report: ' + (e && e.message)); }
    }
  });

  context.subscriptions.push(startCmd, finishCmd);
  out.appendLine('[register] VSC Chat Trail commands registered (start / finish)');
}

// ---------------------------------------------------------------
class Recorder {
  constructor(context, out, opts) {
    this.context = context;
    this.out = out;
    this.id = opts.id;
    this.root = opts.root; // workspace root (may be null)
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
      // No transcript available for a call: estimate ~3 chars ≈ 1 token (prompt and
      // response estimated separately, then summed). The report marks estimates with *.
      const e = charsEst(ev.promptChars || 0, ev.responseChars || 0);
      ev.estTokens = e.total;
      ev.estPrompt = e.prompt;
      ev.estResp = e.response;
    }
    this.events.push(ev);
    if (this.logStream) {
      try { this.logStream.write(JSON.stringify(ev) + '\n'); } catch (e) { this.out.appendLine('[trail] failed to write log: ' + (e && e.message)); }
    }
  }

  async finishAndExport() {
    const endTs = Date.now();
    const out = this.out;

    // 1) End state: branch / HEAD / git user
    let endBranch = null;
    let endHead = null;
    if (this.root) {
      try { endBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.root)).trim() || null; } catch (e) { out.appendLine('[trail] failed to read branch: ' + (e && e.message)); }
      try { endHead = (await runGit(['rev-parse', 'HEAD'], this.root)).trim() || null; } catch (e) { /* no commits yet */ }
    }

    // 2) Stop listeners
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* noop */ } }
    this.disposables = [];
    if (this.logStream) { try { this.logStream.end(); } catch (e) { /* noop */ } this.logStream = null; }

    this.add({ type: 'session_end', notes: 'Recording stopped', head: endHead, branch: endBranch });

    // 3) Git diff relative to the start HEAD (commits made during the session + uncommitted changes)
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
      } catch (e) { out.appendLine('[trail] failed to read git diff: ' + (e && e.message)); }
    }

    // 4) Capture the session transcript (official Export Conversation command; failure is not fatal)
    const transcript = await tryExportTranscript(out);

    // 5) Statistics
    const savesByExt = {};
    for (const ev of this.events) {
      if (ev.type === 'file_saved') {
        const key = ev.ext || '';
        savesByExt[key] = (savesByExt[key] || 0) + 1;
      }
    }
    const modelCalls = this.events.filter((e) => e.type === 'model_call');
    const commandCount = this.events.filter((e) => e.type === 'terminal_cmd').length;

    const data = {
      generatorVersion: 'vsc-chat-trail v0.3.0',
      schemaVersion: 'trail-jsonl-1',
      id: this.id,
      startTs: this.startTs,
      endTs,
      durationMs: endTs - this.startTs,
      workspaceFolderName: this.root ? path.basename(this.root) : '(no workspace)',
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

    // 6) Write HTML + JSON
    const tsName = new Date(endTs).toISOString().replace(/[:.]/g, '-');
    const reportDir = path.join(this.outputDir, 'reports');
    try { fs.mkdirSync(reportDir, { recursive: true }); } catch (e) { out.appendLine('[trail] failed to create report directory: ' + (e && e.message)); }
    const htmlPath = path.join(reportDir, `${this.id}-${tsName}.html`);
    const jsonPath = path.join(reportDir, `${this.id}-${tsName}.json`);
    try {
      fs.writeFileSync(htmlPath, buildReport(data), 'utf8');
      fs.writeFileSync(jsonPath, buildJsonReport(data), 'utf8');
      out.appendLine(`[trail] reports written:\n  HTML ${htmlPath}\n  JSON ${jsonPath}`);
      return { htmlPath, jsonPath };
    } catch (e) {
      out.appendLine('[trail] failed to write reports: ' + (e && e.stack || e && e.message));
      vscode.window.showErrorMessage('VSC Chat Trail: failed to write report ' + (e && e.message));
      return null;
    }
  }

  static async start(context, out, tag) {
    const folders = vscode.workspace.workspaceFolders || [];
    const root = folders.length ? folders[0].uri.fsPath : null;

    // Output directory: default is .vsc-chat-trail under the workspace; without a
    // workspace folder, fall back to the extension's global storage.
    const cfgDir = vscode.workspace.getConfiguration('vscChatTrail').get('outputDir', '.vsc-chat-trail');
    const outputDir = root ? path.join(root, cfgDir) : path.join(context.globalStorageUri.fsPath, 'trail');
    try { fs.mkdirSync(path.join(outputDir, 'sessions'), { recursive: true }); } catch (e) { out.appendLine('[trail] failed to create sessions directory: ' + (e && e.message)); }

    // Initial git state
    let startHead = null;
    let startBranch = null;
    let gitUser = null;
    if (root) {
      try { startHead = (await runGit(['rev-parse', 'HEAD'], root)).trim() || null; } catch (e) { out.appendLine('[trail] no HEAD (empty repository?): ' + (e && e.message)); }
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

    // Listen for file saves
    rec.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!doc || doc.uri.scheme !== 'file') return;
      const rel = root ? path.relative(root, doc.uri.fsPath) : doc.uri.fsPath;
      if (rel.startsWith('.git')) return;
      const ext = path.extname(doc.uri.fsPath).toLowerCase();
      rec.add({ type: 'file_saved', relPath: rel, languageId: doc.languageId, ext });
    }));

    // Listen for terminal command completion (Shell Integration; skipped on older
    // VS Code versions that lack this API)
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

// Try to capture the current session transcript via the official export commands.
// The command ID differs across versions, so try each candidate in turn.
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
      if (before && uri === before) continue; // no new editor was produced
      const text = ed.document.getText();
      if (text && text.trim().length > 0) {
        // If this is an untitled document we triggered, close it after reading so the
        // user is not disturbed.
        if (ed.document.uri.scheme === 'untitled') {
          try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch (e) { /* noop */ }
        }
        out.appendLine(`[trail] transcript captured (source=${id}, ${text.length} chars)`);
        return { source: id, text };
      }
    } catch (e) { /* this command is unavailable — try the next one */ }
  }
  out.appendLine('[trail] could not capture transcript automatically (no export command available or no session to export)');
  return null;
}

module.exports = { registerTrail, logModelCall };
