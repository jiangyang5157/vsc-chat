// VSC Chat Trail — session recorder for VS Code Chat
//
// Records the observable facts of one AI collaboration session (git diff, file
// saves, terminal commands, model calls reported by custom chat participants)
// and exports an HTML/JSON audit report when the session ends.
//
// Local-only: makes no model calls, needs no API key, uploads nothing.
// Pure JavaScript, no build step. Run: open this folder in VS Code and press F5.
//
// History: v0.2 shipped two experimental chat participants — @probe (verified the
// extension could borrow the chat session model via request.model) and @asb-runbook
// (local keyword search over team runbooks). Both checks passed and were not part of
// the daily workflow, so v0.3 removed them. If a model-calling participant is added
// later, replicate @probe's request.model path (see git history) and report model
// calls through trail.logModelCall.

'use strict';

const vscode = require('vscode');
const { registerTrail } = require('./trail');

function activate(context) {
  const out = vscode.window.createOutputChannel('VSC Chat Trail');
  context.subscriptions.push(out);
  registerTrail(context, out);
  out.appendLine('[activate] VSC Chat Trail activated');
}

function deactivate() {}

module.exports = { activate, deactivate };
