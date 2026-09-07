// VSC Chat Toolkit —— 围绕 VS Code Chat 的最小工具包（纯本地，不需要 API key）
//
// 这个扩展验证两件事（对应你公司的两条硬约束）：
//   1) 自研 chat 参与者能不能通过 request.model 借用"当前 chat 会话"里用户选择的模型
//      （gpt/claude/gemini/auto 等 —— 鉴权走你登录的 chat 账号，不需要 API key）
//   2) 一个零模型依赖的 @asb-runbook 检索参与者，先让"纯程序化工具"跑通
//
// 纯 JavaScript，无构建步骤。运行方式：用 VS Code 打开本文件夹，按 F5。

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { registerTrail, logModelCall } = require('./trail');

const STOPWORDS = new Set([
  'and', 'or', 'the', 'for', 'with', 'how', 'to', 'what', 'when', 'where',
  'why', 'your', 'you', 'this', 'that', 'from', 'are', 'can', 'is', 'in',
  'on', 'a', 'an', 'of', 'do', 'does', 'be', 'by', 'as', 'at', 'it', 'me',
  '我', '你', '他', '她', '的', '了', '吗', '呢', '是', '在', '把', '被', '用',
  '一个', '怎么', '如何', '什么', '这个', '那个', '请', '帮'
]);

function activate(context) {
  const out = vscode.window.createOutputChannel('VSC Chat Toolkit');
  context.subscriptions.push(out);
  registerProbe(context, out);
  registerRunbook(context, out);
  registerTrail(context, out);
  out.appendLine('[activate] VSC Chat Toolkit 已激活');
}

// ============================================================
// @probe —— 探测 request.model 是否可用
// ============================================================
function registerProbe(context, out) {
  const handler = async (request, _chatContext, stream, token) => {
    const push = (s) => out.appendLine(s);

    push('===== PROBE START =====');
    push(`VS Code version : ${vscode.version}`);
    push(`时间            : ${new Date().toISOString()}`);

    const report = { modelGiven: false, modelSendOk: false, listOk: false, listSendOk: false, errors: [] };
    const errNote = [];

    // 1) request.model —— chat 顶部模型下拉框选中的模型，随请求交给被 @ 的参与者
    const model = request.model;
    report.modelGiven = !!model;
    if (model) {
      push(`request.model   : 有  (name=${model.name}, id=${model.id}, vendor=${model.vendor})`);
    } else {
      push('request.model   : 无 (undefined) —— chat 没有把模型交给这个参与者');
    }

    // 2) 若拿到了模型，真的发一条测试消息
    if (model && typeof model.sendRequest === 'function') {
      const t0 = Date.now();
      const promptText = '只回复一个词：PONG';
      try {
        const resp = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(promptText)],
          {},
          token
        );
        let text = '';
        for await (const frag of resp.text) {
          text += frag;
          if (text.length > 120) break;
        }
        report.modelSendOk = text.trim().length > 0;
        push(`sendRequest     : 成功  (模型回复: "${text.trim().slice(0, 60)}")`);
        logModelCall({
          participant: 'probe', model: (model.id || model.name || '?'),
          ok: true, latencyMs: Date.now() - t0,
          promptChars: promptText.length, responseChars: text.length
        });
      } catch (e) {
        const msg = `${e && e.name ? e.name + ': ' : ''}${(e && e.message || '').slice(0, 200)}`;
        push(`sendRequest     : 失败  ${msg}`);
        report.errors.push('request.model.sendRequest: ' + msg);
        logModelCall({
          participant: 'probe', model: (model.id || model.name || '?'),
          ok: false, latencyMs: Date.now() - t0,
          promptChars: promptText.length, responseChars: 0, error: msg
        });
      }
    }

    // 3) 后备探测：不依赖 request.model，直接用 vscode.lm 列出并尝试调用模型
    if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
      try {
        const models = await vscode.lm.selectChatModels();
        report.listOk = true;
        const desc = models.map((m) => `${m.vendor}/${m.id}`).join(', ') || '(空列表)';
        push(`selectChatModels: 有 ${models.length} 个: ${desc}`);
        if (!model) {
          const fallback = models.find((m) => /copilot/i.test(m.vendor || '')) || models[0];
          if (fallback && typeof vscode.lm.sendChatRequest === 'function') {
            try {
              const resp = await vscode.lm.sendChatRequest(
                fallback,
                [vscode.LanguageModelChatMessage.User('只回复一个词：PONG')],
                {},
                token
              );
              let text = '';
              for await (const frag of resp.text) {
                text += frag;
                if (text.length > 120) break;
              }
              report.listSendOk = text.trim().length > 0;
              push(`selectChatModels 调用: 成功 (${fallback.id} 回复 "${text.trim().slice(0, 60)}")`);
            } catch (e) {
              const msg = `${e && e.name ? e.name + ': ' : ''}${(e && e.message || '').slice(0, 200)}`;
              push(`selectChatModels 调用: 失败  ${msg}`);
              report.errors.push('selectChatModels.sendChatRequest: ' + msg);
            }
          }
        }
      } catch (e) {
        const msg = `${e && e.name ? e.name + ': ' : ''}${(e && e.message || '').slice(0, 200)}`;
        push(`selectChatModels: 抛错  ${msg}`);
        report.errors.push('selectChatModels: ' + msg);
      }
    } else {
      push('vscode.lm       : 不可用 (VS Code 版本太老？需要 1.95+)');
    }

    // 4) 结论判定
    let verdict;
    if (report.modelGiven && report.modelSendOk) {
      verdict = '✅ PASS —— request.model 可用。你可以放心设计“会调用模型的参与者”(@asb-review / @asb-story 等)。';
    } else if (report.modelGiven && !report.modelSendOk) {
      verdict = '❌ FAIL(request.model 给了，但调用被拒) —— 看上面的报错，通常是企业策略/授权限制，把报错发给管理员。';
    } else if (!report.modelGiven && report.listSendOk) {
      verdict = '⚠️ PARTIAL —— request.model 没给，但 vscode.lm 能列出并调用模型。能用，但这是备用通道，兼容性要自己盯。';
    } else if (!report.modelGiven && report.listOk && report.errors.length === 0) {
      verdict = '⚠️ PARTIAL —— 能列出模型但没实际调用。先升级 VS Code / Copilot Chat 再测一次。';
    } else {
      verdict = '❌ FAIL —— chat 没有把模型交给第三方扩展。你暂时只能做“纯程序化”参与者(检索/命令/记录)，或找管理员开第三方 chat 扩展策略。';
    }
    push(`结论            : ${verdict}`);
    push('===== PROBE END =====');

    const md = [
      '### 🔍 Chat 模型访问探测结果',
      '',
      `- **VS Code 版本**：\`${vscode.version}\``,
      `- **request.model**(chat 下拉框选的模型)：${report.modelGiven ? `有 → \`${model.name}\` (\`${model.vendor}/${model.id}\`)` : '**无 (undefined)**'}`,
      `- **实际发送测试消息**：${report.modelGiven ? (report.modelSendOk ? '✅ 成功，模型回复了' : '❌ 失败，见报错') : '未执行(没有 model)'}`,
      report.listOk ? `- **vscode.lm 后备通道**：可用(${report.listSendOk ? '且调用成功 ✅' : '列出成功，调用见报错/未尝试'})` : '- **vscode.lm 后备通道**：不可用',
      '',
      '**结论：**',
      '',
      verdict,
      '',
      '> 详细日志：菜单栏 查看(View) → 输出(Output) → 下拉选 **VSC Chat Toolkit**',
      '> 判定对照表与下一步：见本扩展的 README.md'
    ];
    stream.markdown(md.join('\n'));
    return { metadata: { probe: true, verdict } };
  };

  const probe = vscode.chat.createChatParticipant('vsc-chat-tools.probe', handler);
  probe.description = '探测当前 chat 会话能否把模型(request.model)交给扩展调用';
  context.subscriptions.push(probe);
  out.appendLine('[register] @probe 已注册');
}

// ============================================================
// @asb-runbook —— 在本地目录里检索团队 markdown 文档（纯程序化）
// ============================================================
function registerRunbook(context, out) {
  const handler = async (request, _chatContext, stream, _token) => {
    const wsFolders = vscode.workspace.workspaceFolders || [];
    const wsRoot = wsFolders[0] ? wsFolders[0].uri.fsPath : null;

    // 收集检索根目录
    const roots = [];
    const cfg = vscode.workspace.getConfiguration('vscChat');
    const cfgDirs = cfg.get('runbookDirs', ['docs/runbooks']);
    for (const d of cfgDirs) {
      if (!d) continue;
      const p = path.isAbsolute(d) ? d : (wsRoot ? path.join(wsRoot, d) : d);
      if (fs.existsSync(p) && !roots.includes(p)) roots.push(p);
    }
    // 兜底：扩展自带的示例文档，保证开箱就能演示
    const bundled = path.join(context.extensionPath, 'docs', 'runbooks');
    if (fs.existsSync(bundled) && !roots.includes(bundled)) roots.push(bundled);

    const query = String(request.prompt || '').trim();
    const tokens = tokenize(query);

    if (!query || tokens.length === 0) {
      const dirList = cfgDirs.join('、');
      stream.markdown([
        '### 📚 @asb-runbook 用法',
        '',
        '在这个参与者后面直接问问题，例如：',
        '',
        '```',
        '@asb-runbook 本地怎么跑 iOS 的单元测试',
        '@asb-runbook release 前 checklist',
        '```',
        '',
        '检索范围（本地、不上传任何内容）：',
        `- 配置 \`vscChat.runbookDirs\` 里的目录：\`${dirList}\``,
        `- 工作区: ${wsRoot || '(未打开文件夹)'}`,
        `- 当前生效的根目录: ${roots.map((r) => r.replace(context.extensionPath, '<扩展目录>')).join('、') || '(无)'}`,
        '',
        '> 提示：把团队文档(.md)放进工作区的 `docs/runbooks/`，关键词给 2~4 个更准。'
      ].join('\n'));
      return { metadata: { hit: 0 } };
    }

    // 扫描所有根目录下的 .md 文件（限深度、限大小）
    const docs = [];
    for (const root of roots) {
      walkMd(root, 0, docs, out);
    }
    out.appendLine(`[asb-runbook] query="${query}" tokens=[${tokens.join(',')}] docs=${docs.length}`);

    if (docs.length === 0) {
      stream.markdown('没有找到任何 markdown 文档。把团队文档放进工作区 `docs/runbooks/`（或改设置 `vscChat.runbookDirs`）再试。');
      return { metadata: { hit: 0 } };
    }

    // 打分：关键词在正文中出现的次数（文件名命中额外加分）
    const scored = [];
    for (const doc of docs) {
      const body = doc.content.toLowerCase();
      let score = 0;
      const matched = [];
      for (const t of tokens) {
        const n = countOccurrences(body, t);
        if (n > 0) { score += n * (t.length >= 4 ? 2 : 1); matched.push(t); }
      }
      if (matched.length) {
        const rel = doc.file.replace(context.extensionPath, '<扩展目录>');
        if (new RegExp(tokens.map(escapeRegExp).join('|'), 'i').test(doc.base)) score += 5;
        scored.push({ doc, rel, score, matched });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);

    if (top.length === 0) {
      stream.markdown(`在 ${docs.length} 份文档里没匹配到 \`${query}\`。试试换关键词，或确认文档在检索目录里。`);
      return { metadata: { hit: 0 } };
    }

    // 渲染结果
    const parts = [
      `### 📚 runbook 检索：\`${query}\``,
      '',
      `在 **${docs.length}** 份文档中找到 top **${top.length}**：`,
      ''
    ];
    for (const t of top) {
      const lines = excerpt(t.doc.content, t.matched);
      parts.push(`**${t.rel}**  （得分 ${t.score}，命中词: ${t.matched.slice(0, 5).join('、')}）`);
      parts.push('```');
      parts.push(lines);
      parts.push('```');
      parts.push('');
    }
    parts.push('> 若要基于这些文档生成回答/总结，等 @probe 判定通过后，我们可以给本参与者加上“用模型回答”模式。');
    parts.push('> 更详细日志：Output 面板 → VSC Chat Toolkit');
    stream.markdown(parts.join('\n'));
    return { metadata: { hit: top.length } };
  };

  const rb = vscode.chat.createChatParticipant('vsc-chat-tools.asb-runbook', handler);
  rb.description = '在 docs/runbooks 等本地目录检索团队文档(纯程序化，不调用模型)';
  context.subscriptions.push(rb);
  out.appendLine('[register] @asb-runbook 已注册');
}

// ============================================================
// 工具函数
// ============================================================
function tokenize(text) {
  return String(text).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOPWORDS.has(s));
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkMd(dir, depth, acc, out) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) walkMd(full, depth + 1, acc, out);
      else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        const size = fs.statSync(full).size;
        if (size > 400 * 1024) { out.appendLine(`[asb-runbook] 跳过超大文件: ${full}`); continue; }
        const content = fs.readFileSync(full, 'utf8');
        acc.push({ file: full, base: ent.name, content });
      }
    } catch (e) { /* 单文件读失败跳过 */ }
  }
}

function excerpt(content, matchedTokens) {
  const lines = content.split(/\r?\n/);
  const re = new RegExp(matchedTokens.map(escapeRegExp).join('|'), 'i');
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) {
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.slice(0, 300) + (flat.length > 300 ? '…' : '');
  }
  const start = Math.max(0, idx - 1);
  const chunk = lines.slice(start, idx + 2).join('\n').trim();
  return chunk.slice(0, 400) + (chunk.length > 400 ? '\n…' : '');
}

function deactivate() {}

module.exports = { activate, deactivate };
