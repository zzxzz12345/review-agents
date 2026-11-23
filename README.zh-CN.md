[English](README.md) | [简体中文](README.zh-CN.md)

# Review Agents — 基于 ACP 的 VS Code 语音与交互式白板代码导读助手

**Review Agents** 是一款基于 **ACP（Agent Client Protocol）** 构建的 VS Code 扩展。它像一位资深架构师同事那样，通过 **自顶向下的交互式 Mermaid 白板**、**右侧主题过滤主调用链导读栏**、**步进式 ≤10 行源码居中高亮跳转**、**全双工语音打断问答** 以及 **自动 Action/批注记录**，带你高效复盘 PR、本地分支 Diff 或直接了解当前项目代码。

---

## 核心特性

### 1. 三种导读与 Review 模式
- **当前分支 / 项目导读与按指令 Review（无需选择 PR）**：
  无需选定任何 PR 或 Diff 基准，直接基于当前工作区 / 分支启动，支持三种启动方式：
  - **输入自定义指令**（例如：*「帮我 Review 鉴权模块的并发锁边界」* 或 *「自顶向下讲解语音交互主链路」*）；
  - **自动梳理 L1 全局项目架构**；
  - **直接连接待命**（或在空白白板界面直接打字/开口提问，系统将自动开启当前分支导读）。
- **本地 Git 分支 / 提交 Diff**：本地对比任意分支、Tag 或 Commit（自动计算 `merge-base`）。
- **Bitbucket Pull Request（Cloud & Server / Data Center）**：浏览仓库 Open PR 或粘贴 PR 链接/编号，通过 `review-git://` 虚拟只读文档离线看 Diff，并支持将评审草稿批量发布回 Bitbucket。

### 2. 自顶向下多图表交互式 Mermaid 白板
- **人类复盘式四层节奏（`L1 → L2 → L3 → L4`）**：先用全局图建立心智模型，再下钻到模块/类设计结构，最后精准聚焦局部变更与代码细节，并在关键节点主动停顿把控制权交还给你。
- **按场景自动选择最适合的图表 + Note 批注**：不再一律只画流程图，而是按内容自动选用 `flowchart`、`erDiagram`（实体关系）、`sequenceDiagram`（时序图）、`classDiagram`（类图）、`stateDiagram-v2`（状态机），配合适配深浅色主题的 Mermaid `Note` 标注设计约束与风险点。
- **无损面包屑导航（`L1 ↔ L2 ↔ L3`）**：在 `L2` 点击顶部面包屑回到 `L1` 后，不会销毁下层视图，可随时一键切回 `L2`/`L3`。
- **丝滑画布交互**：触控板双指平移 / 捏合缩放；单击节点选中上下文（直接围绕该节点追问）；双击节点直达源码；支持 **「独立窗口」** 弹出到副屏常驻。

### 3. 每步联动源码 + 严格 ≤10 行居中高亮
- **记忆默认源码视图**：默认打开真实可编辑的工作区源码文件（并记忆用户的视图切换偏好），随时可切换原生 Diff 视图；即使在 Diff 偏好下，跳转未修改文件或 Hunk 以外的行也会自动切回源码视图。
- **局部片段高亮（单次 ≤10 行）**：每次跳转强制限制高亮跨度不超过 **10 行** 并自动在编辑器正中展示（`InCenter`），避免重点代码掉到第二屏；讲解长方法时会随口播进度分段滚动高亮。
- **焦点兜底跳转**：当 Agent 在某句话仅高亮白板节点（`<wb_focus>`）时，宿主会自动从节点映射表中定位并打开对应局部源码。

### 4. 白板右侧「主调用链导读栏」（Agent 主题精简 + 本地/LSP 校准）
- **自顶向下纵向调用时间轴**：`全局入口 → 主要父方法 → ▶ 当前方法`，直观展示当前讲解代码在全局处于哪一环、经过了哪些主要父方法调用过来。
- **主题自动降噪 + 行号校准**：由 Agent 围绕当前讲解主题过滤 getter、日志、工具类和测试调用，只保留 2~6 步核心主链路；同时扩展宿主自动读取本地源文件校准精准行号，并随后续 `<code_goto>` 自动移动 `▶ 当前` 高亮。
- **按需 LSP 展开真实调用方**：每张卡片提供 **「调用方」** 按钮，一键调用 VS Code 原生 LSP `CallHierarchy`（`provideIncomingCalls`，无语言服务时降级为有界 `git grep`）展开上游调用方并自动过滤测试/Mock 路径；右上角 **「反查」** 可直接基于当前光标反查上游链路。
- **不打断语音的源码预览**：单击侧栏任意父方法卡片直接跳转源码且不中断讲解；点击 **「问 Agent」** 可针对该节点发起追问。
- **自适应响应式布局**：宽屏（`≥680px`）自动展开、窄分屏自动折叠，支持拖拽左边缘调整宽度（`200–440px`）及顶部工具栏 **「调用链」** 一键开关。

### 5. 全双工语音交互、一键暂停与依赖自动安装
- **宿主原生麦克风采集**：在 VS Code Extension Host 直接调用 `sox` / `rec`、macOS Swift `AVAudioEngine` 或 Linux `arecord` 采集 16kHz PCM 音频，彻底解决 Webview 无法获取麦克风权限（`Permission denied`）的问题。
- **双语音模式**：
  - **全双工 VAD 模式**：Agent 播报途中随时开口即可打断（立即中止播放与 ACP 生成，并将已播/未播上下文快照传给下一轮）。
  - **按键 PTT 模式**：按住 **`Option`（`Alt`）** 键说话，松开自动识别发送。
- **零配置语音链路 + 依赖自动安装**：内置 Edge Neural TTS（离线自动降级 macOS `say`）+ 本地 `whisper-cli`（`ggml-small-q5_1.bin` 支持 HuggingFace / 国内镜像双源下载）+ OpenAI 兼容云端扩展槽位；启动或开启麦克风时自动检测并一键安装缺失的 `sox`、`whisper-cpp`、Whisper 模型及受支持的 ACP CLI。

### 6. 自动识别 Action 批注与遥测日志
- **自动识别 Action / 待办**：在语音或文字中说出「记一个 action」「帮我记一下」「记下来」「记录它」等意图（内置常见中文语音同音误识别容错，如「记忆reaction」「揭露它」），Agent 自动写入 VS Code 行内批注与右上角 **「批注」** 抽屉，支持一键导出 Markdown 待办清单（`- [ ] **[ACTION]**`）或发布到 Bitbucket PR。
- **实时 Agent 活动状态栏**：展示当前思考摘要、正在读取的源码文件（`fs/read_text_file`）、语音合成进度，并在超过 15 秒无心跳时提示超时可手动中断。
- **结构化 JSONL 遥测日志**：自动记录首字延迟（`ttftMs`）、首音延迟（`firstAudioMs`）、Token 消耗与交互轨迹到 `globalStorage/logs`。

---

## 环境准备

- **VS Code** `^1.93.0`
- **Node.js** `20+`（从源码构建时需要）
- 至少安装一个 **ACP 兼容的 Agent CLI**（默认使用 `agy`）：
  - `agy`（默认命令：`agy acp --sandbox`）
  - `claude-code-acp`
  - `codex-acp`
  - `gemini`（`gemini --experimental-acp`）
  - 或在配置中选择 `reviewAgents.acp.profile = "custom"` 自定义命令
- *（本地语音功能可选依赖）*：`sox` 与 `whisper-cpp`（macOS 若已安装 Homebrew，首次启动或打开麦克风时会自动检查安装，也可手动执行命令 **`Review Agents: Check & Auto-Install Dependencies (CLI & Models)`**）。

---

## 快速开始与安装

### 从源码编译并安装到本地 VS Code（推荐）

```bash
git clone https://github.com/zzxzz12345/review-agents.git
cd review-agents
npm run install:all
npm run build
npx --yes @vscode/vsce package --no-dependencies -o review-agents-0.1.0.vsix
code --install-extension review-agents-0.1.0.vsix --force
```

安装完成后，在 VS Code 中执行 **`Developer: Reload Window`** 重载窗口，然后通过以下任一方式启动：
- 打开命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）运行 **`Review Agents: Explore / Review Current Branch (No PR)`**（无需 PR，直接基于当前分支开始）；
- 或运行 **`Review Agents: Start Voice & Whiteboard Review`** / 点击左下角状态栏 **`Review Agents`** 选择目标模式。

### 调试开发模式运行

用 VS Code 打开本仓库，运行 `npm run install:all && npm run build` 后直接按 **`F5`** 启动 Extension Development Host。

---

## 快捷键与操作指南

| 快捷键 / 操作 | 功能说明 |
| :--- | :--- |
| **`Space`（空格）** | **暂停 / 恢复** 语音讲解与自动代码跳转（在底部输入框打字时自动放行，不冲突） |
| **按住 `Option`（`Alt`）** | 在 **按键 PTT** 模式下按住说话、松开发送识别 |
| **直接开口说话** | 在 **全双工 VAD** 模式下自动检测人声并立即打断当前播报 |
| **单击白板节点** | 选中该节点作为上下文，随后的语音/文字提问将自动围绕该节点展开 |
| **双击白板节点** | 直接打开并高亮该节点对应的本地源码 |
| **双指滑动 / 捏合** | 在 Mermaid 白板画布上平移或缩放视角 |
| **单击右侧调用链卡片** | 居中高亮跳转到对应父方法源码（≤10 行），**不打断**当前语音播报 |

---

## 常用命令清单

在 VS Code 命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）中可使用以下全部命令：

| 命令名称 | 说明 |
| :--- | :--- |
| `Review Agents: Explore / Review Current Branch (No PR)` | **当前分支导读 / 按指令 Review**（无需选 PR） |
| `Review Agents: Start Voice & Whiteboard Review` | 选择导读数据源（当前分支 / Local Diff / Bitbucket PR） |
| `Review Agents: Open/Focus Whiteboard` | 打开或聚焦 Mermaid 白板窗口 |
| `Review Agents: Pop Out Whiteboard to New Window` | 将白板弹出到独立悬浮窗口（适合双屏） |
| `Review Agents: Pause / Resume Walkthrough` | 暂停 / 恢复语音讲解与自动代码跳转 |
| `Review Agents: Toggle Diff / Source View` | 在 Diff 视图与源码视图间切换（自动记忆偏好） |
| `Review Agents: Publish Draft Notes to Bitbucket PR` | 将评审草稿批量发布到 Bitbucket PR |
| `Review Agents: Export Markdown Review Report` | 导出含 Mermaid 图表与 Action 清单的 Markdown 报告 |
| `Review Agents: Configure Bitbucket Credentials` | 配置并加密保存 Bitbucket 认证凭据 |
| `Review Agents: Configure Speech Provider API Key` | 配置云端语音合成/识别 API Key |
| `Review Agents: Check & Auto-Install Dependencies (CLI & Models)` | 检查并自动安装 `sox`、`whisper-cpp`、离线语音模型及 ACP CLI |
| `Review Agents: Download Local Whisper STT Model` | 手动下载离线 Whisper 模型（`ggml-small-q5_1.bin`，约 181 MB） |
| `Review Agents: Open Usage Logs Folder` | 打开结构化 JSONL 遥测日志目录 |
| `Review Agents: End Review Session` | 结束当前导读会话并清理高亮状态 |

---

## 核心配置项

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `reviewAgents.acp.profile` | `"agy"` | ACP 后端预设：`"agy"`、`"claude-code"`、`"codex"`、`"gemini"` 或 `"custom"` |
| `reviewAgents.acp.preferredModel` | `"Gemini 4 Hydrogen, auto/claude-sonnet-5-5:low"` | 优先选用的 ACP 模型列表（按逗号分隔优先级） |
| `reviewAgents.acp.thoughtLevel` | `"low"` | 推理思考深度（`"low"` / `"medium"` / `"high"`，语音交互推荐 `"low"` 以降低首包延迟） |
| `reviewAgents.speech.ttsProvider` | `"edge-neural"` | TTS 语音合成后端：`"edge-neural"`、`"system-native"` 或 `"openai-compat"` |
| `reviewAgents.speech.sttProvider` | `"system-native"` | STT 语音识别后端：`"system-native"`（本地 Whisper）或 `"openai-compat"` |
| `reviewAgents.speech.ttsVoice` | `"zh-CN-XiaoxiaoNeural"` | 语音合成音色 |
| `reviewAgents.speech.ttsRate` | `1.1` | 语速倍率（`0.5`–`2.0`） |
| `reviewAgents.speech.sttLocale` | `"zh-CN"` | 语音识别语言偏好 |
| `reviewAgents.voice.interactionMode` | `"vad"` | 语音交互模式：`"vad"`（全双工自动打断）或 `"ptt"`（按住 `Option` 说话） |
| `reviewAgents.setup.autoInstallDependencies` | `true` | 是否自动检查并安装缺失的本地 CLI 与语音模型 |
| `reviewAgents.context.maxContextChars` | `12000` | 预分析 Context Pack 的字符预算（`4000`–`120000`） |
| `reviewAgents.logging.enabled` | `true` | 是否记录结构化 JSONL 性能与行为日志 |

---

## 常见问题排查

1. **首次开启麦克风提示系统权限或无声音输入**：
   请确认系统「隐私与安全性 -> 麦克风」中已允许 **Visual Studio Code**（macOS）使用麦克风；状态栏与活动栏会实时显示麦克风音量条。
2. **本地语音识别报模型缺失或下载缓慢**：
   运行 **`Review Agents: Check & Auto-Install Dependencies (CLI & Models)`** 会自动在 HuggingFace 与 `hf-mirror.com` 镜像间切换下载 `ggml-small-q5_1.bin`；若仅需文字交互，也可直接在白板底部输入框打字提问。
3. **LSP「调用方 / 反查」无结果**：
   LSP 调用链检索依赖 VS Code 内置或已安装语言扩展（如 TypeScript/JavaScript、Python/Pylance、Go、Rust 等）完成索引；索引未完成或动态派发时会自动回退到非测试源码的 `git grep` 引用检索。

---

## 本地开发与测试

```bash
npm run typecheck   # 检查 Extension Host 与 Webview 类型
CI=true npm test    # 运行 Vitest 单元测试与集成测试
npm run build       # 构建 Extension Host (esbuild) 与 Webview (Vite)
```

> 若需运行真实的 ACP CLI 冒烟测试，可设置 `LIVE_ACP_SMOKE=1 npm test`。

## 开源协议

[MIT](LICENSE)
