# VSC Chat Toolkit

围绕 **VS Code 里的 chat 窗口** 的最小内部工具包。概念上它服务的是"chat"，而不是某个特定厂商：只要 chat 会话能把模型(`request.model`)交给扩展，工具就成立（你公司当前用的厂商 chat 是 GitHub Copilot，纯属事实背景）。

纯本地、无构建步骤、不需要任何 API key。

| 成员 | 作用 | 是否需要模型 |
|---|---|---|
| `@probe` | 探测：当前 chat 会话是否把模型(`request.model`)交给你的扩展 | 会尝试调用一次（仅测试，回复 PONG） |
| `@asb-runbook` | 在你本地 markdown 文档里检索团队 runbook（关键词打分） | 不需要（纯程序化） |
| **VSC Chat Trail** | 会话轨迹记录器：录制一次 AI 协作会话 → 导出 HTML 审计报告 | 不需要（只记录，不生成） |

## 文件结构

```
vsc-chat/
├── package.json          # 扩展清单：两个参与者 + Trail 命令 + 设置(vscChat.*)
├── extension.js          # 参与者逻辑（@probe / @asb-runbook）
├── trail.js              # 会话轨迹记录器（录制 + git 差异 + 会话原文快照 + 任务标签）
├── report-builder.js     # HTML/JSON 报告生成（纯函数，可单测）
├── .vscode/launch.json   # F5 调试配置
├── docs/runbooks/        # 示例文档（占位内容，替换成真实的团队文档）
└── README.md
```

## 前置条件

1. VS Code ≥ 1.100
2. 厂商 chat 扩展已安装并登录（当前即 GitHub Copilot Chat），模型下拉框可选模型
3. 不需要 Node / 编译

## 三步跑起来

1. VS Code **打开本文件夹**（`vsc-chat`）
2. 按 **F5** → 弹出 `[Extension Development Host]` 窗口，**所有操作都在新窗口做**
3. 新窗口里打开 Chat（`Ctrl+Alt+I` / `Cmd+Option+I`）→ 输入 `@`，列表里应有 **probe** 和 **asb-runbook**

## 用 @probe

发送 `@probe 测试一下` → 得到探测报告：

| 结论 | 含义 | 下一步 |
|---|---|---|
| ✅ PASS | 你的扩展能借 chat 下拉框的模型 | 可以设计 @asb-review / @asb-story 等会调模型的参与者 |
| ⚠️ PARTIAL | 只拿到模型列表，没拿到 request.model | 升级 VS Code / chat 扩展后重测 |
| ❌ FAIL | chat 不给第三方扩展模型 | 只能做纯程序化工具；把报错发给管理员 |

详细日志：`View → Output` → 下拉选 **VSC Chat Toolkit**。

## 用 @asb-runbook

```
@asb-runbook 本地怎么跑 iOS 的单元测试
```

检索目录默认 `docs/runbooks/`（可设置 `vscChat.runbookDirs`，支持绝对路径）。纯本地扫描，不上传任何内容。

## VSC Chat Trail —— 会话轨迹记录器（v0.2）

像"录像机"一样记录一次 AI 协作会话的可观测事实，结束导出 HTML 审计报告 + JSON。

```text
1. 打开工作区（必须打开文件夹，git 才有效）
2. Ctrl+Shift+P → VSC Chat Trail: ▶ 开始记录会话
   （会问一个可选"任务标签"，如 STORY-1234 / review / 修bug —— 为以后按任务/技能聚合分析留的）
3. 正常干活：开 chat / agent 让它改代码、跑测试、用 @probe 等自研参与者……
4. Ctrl+Shift+P → VSC Chat Trail: ■ 结束并导出 HTML 审计报告 → 浏览器自动打开
```

报告章节：会话元信息（含任务标签）→ **本次会话汇总**（时长/保存数/命令数/变更文件数/自研调用数+平均耗时/估算 token 合计）→ AI 变更摘要(git) → 时间线 → 模型调用表 → 会话原文快照 → 已知局限。

数据落在 `<工作区>/.vsc-chat-trail/`：`sessions/*.jsonl` + `reports/*.html|.json`（已 gitignore）。

## 诚实边界（为什么有的数据没有）

- **模型内部思维链、agent 每步工具调用明细**：厂商 chat 不向任何扩展暴露，做不到。
- **原生对话的真实 token / 缓存命中 / 成本**：扩展 API 无 usage 字段。唯一官方路径是组织级 Copilot metrics API（需管理员开）——那也只能到"用户/天"粒度，到不了"某个会话"。
- **auto 实际路由到哪个模型**：对原生对话不可知；只有自研参与者能记录下拉框当前选择。
- 因此报告里：**能测的都是实测**（耗时、字符、git、事件）；**token 一律字符估算并标 `*`**。审计材料区分事实与推断是底线。

## FAQ

**Q：probe 是什么东西？是个模型吗？**
A：不是模型。它是这个扩展注册的一个"测试座席"（chat 参与者）。你 `@probe` 它时，它只是做一件事：把"只回复一个词 PONG"发给**当前 chat 会话下拉框选中的那个模型**，然后报告"扩展到底能不能借到模型"。PASS 的含义是：以后我们自研的任何参与者都能用同样的通道调用模型，且不需要 API key。

**Q：测试 Trail 时为什么让我"用一次 @probe"？什么时候用？**
A：@probe 不是工作流的一部分，它只是测试用的**数据发生器**，用来验证"自研参与者模型调用"这条数据链路能通（事件 → 时间线 → 汇总表）。一次就够验证管道。时机随意，**只要在 ▶ 开始 和 ■ 结束 之间**（同一窗口）即可，调用会被自动打时间戳；在开始之前或结束之后用则不会被记录。改代码、agent 跑任务不需要 @probe——那些靠 git/文件/终端事件自动记录。将来真实的 @asb-review 等参与者被任务自然用到时，走的是同一个记录钩子，那才是"自研参与者数据"的常态来源。

**Q：上次报告里 token 是 "?*"，没有数据？**
A：两个原因：① v0.1 的 `model_call` 没算估算值——v0.2 已修（无真实 usage 时按约 3 字符≈1 token 粗估，报告标 `*`）；② 只有**自研参与者在你录制期间被实际使用**（如 @probe）才会有记录——你如果全程只用原生 chat 窗口，这一节本来就该是空的，因为原生对话的用量厂商不开放给扩展。这不是 bug，是边界。

**Q：真实场景中，能算"某个会话一共"的数据吗？**
A：能算与不能算要分开：
- 能算（v0.2 新增"本次会话汇总"表，全部为实测或明确估算）：录制时长、文件保存数、终端命令数、git 变更文件数、自研参与者调用次数/成功率/平均耗时、会话原文长度与估算 token、自研调用估算 token 合计。
- 算不了：原生对话的真实 token/成本/缓存命中（无 API 出口；组织级 metrics API 是唯一官方路径，需管理员，粒度到不了单会话）。

**Q：代码里的 STOPWORDS 是什么意思？**
A："停用词表"。runbook 检索时把用户问题拆成关键词，但像 `and/the/的/了/怎么/如何` 这类词对"找出哪份文档"没帮助，还会制造噪音，所以先滤掉。目前已知局限：中文没有空格分词，长句如"本地怎么跑iOS的单元测试"会切出整段而不是词（日志里 `tokens=[本地怎么跑,ios,的单元测试]` 就是这么来的），中文检索质量待优化——属于路线图里的待办。

## 要发给管理员的确认清单

1. Enterprise 策略是否允许**第三方 chat 扩展**（policy：Chat extensions / Copilot extensions）？
2. 是否有 MCP 工具白名单策略（影响以后给 agent 加"工具点"）？
3. chat 模型下拉框由谁控制、auto 实际路由哪些模型？
4. （可选，为了真实用量数据）能否开组织级 **Copilot metrics API** 的读取权限？

## 路线图

- [x] @probe 模型访问探测（你已测出 PASS）
- [x] @asb-runbook 纯本地检索（中文分词待优化）
- [x] VSC Chat Trail v0.2：录制 + git 差异 + 会话原文快照 + 任务标签 + 会话汇总 + HTML/JSON 报告
- [ ] @asb-runbook 加"用模型总结"模式 + 修中文分词
- [ ] 加"工具点"(language model tool)：agent 自动调用你的函数（get-ticket / scan-pii / 跑银行校验）
- [ ] Trail 聚合分析：按任务标签/技能统计（平均耗时、成功率、改动量、估算 token）
