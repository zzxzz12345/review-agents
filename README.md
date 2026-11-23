[English](README.md) | [简体中文](README.zh-CN.md)

# Review Agents — Voice & Interactive Mermaid Whiteboard Code Reviewer for VS Code

**Review Agents** is an **ACP (Agent Client Protocol)** powered VS Code extension that walks you through Pull Requests, local Git branch diffs, or your current branch / project codebase like a senior teammate—combining **top-down interactive Mermaid whiteboards**, a **topic-curated incoming call-chain sidebar**, **step-by-step ≤10-line centered source navigation**, **full-duplex voice Q&A**, and **automatic Action / Review note capture**.

---

## Key Features

### 1. Three Review & Exploration Modes
- **Current Branch / Project Explore & Review (No PR Required)**:
  Launch directly against your active workspace/branch without choosing a PR or diff base. Choose between:
  - **Custom Instruction** (e.g., *"Review edge cases in the auth module"* or *"Walk me through the payment flow"*),
  - **Auto L1 Global Architecture Overview**,
  - **Direct Voice/Text Standby**, or simply open the Whiteboard and start typing/speaking directly to auto-start.
- **Local Git Branch / Commit Diff**: Compare any checked-out branch, tag, or commit locally via merge-base resolution.
- **Bitbucket Pull Request (Cloud & Server / Data Center)**: Browse open PRs or paste a PR URL/ID, inspect diffs offline via virtual `review-git://` documents, and batch-publish review notes back to Bitbucket.

### 2. Top-Down Interactive Mermaid Whiteboard
- **Human-Style Cadence (`L1 → L2 → L3`)**: Starts with a macro architecture/data-flow overview (`L1`), drills down into module/class design (`L2`), and walks through targeted local code blocks (`L3`).
- **Best-Fit Multi-Type Diagrams + Notes**: Automatically chooses the clearest Mermaid diagram type (`flowchart`, `erDiagram`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`) with theme-aware `Note` annotations.
- **Non-Destructive `L1 ↔ L2 ↔ L3` Navigation**: Clicking `L1` in the breadcrumb bar from `L2` preserves deeper levels so you can switch freely back and forth without losing context.
- **Interactive Canvas**: Two-finger trackpad pan/pinch-zoom, single-click a node to scope your next question (`<selected_node>`), double-click a node to jump to its mapped source lines, and **Pop Out to New Window** for multi-monitor setups.

### 3. Step-by-Step Source Sync & ≤10-Line Centered Highlighting
- **Sticky Source View Default**: Opens real editable workspace source files (default `'source'` view, persisted across sessions), while allowing quick toggle to native VS Code Diff view for PR/Branch Diff reviews. Even in Diff mode, unmodified files or lines outside diff hunks automatically open in Source View.
- **Focused Local Slices (≤10 Lines)**: Every code jump caps line highlighting to at most **10 lines** and centers it cleanly in the editor (`InCenter`), preventing key lines from falling onto a second screen.
- **Focus Fallback**: When the agent highlights a mapped node (`<wb_focus>`) without an explicit `<code_goto>`, the extension automatically opens the node's mapped source snippet.

### 4. Curated Incoming Call-Chain Sidebar (Hybrid Agent + LSP)
- A collapsible, drag-resizable right-hand timeline beside the Mermaid whiteboard (`Global Entry → Parent Methods → ▶ Current Method`).
- **Semantic Filtering + Real Calibration**: The agent filters out noisy getters/loggers/tests along the active topic, while the Extension Host calibrates line numbers against local source files and follows subsequent code jumps.
- **On-Demand LSP Caller Expansion**: Click **Callers (`调用方`)** on any step to query VS Code Language Server `CallHierarchy` (`provideIncomingCalls`, with bounded `git grep` fallback), automatically filtering test/mock paths.
- **Non-Interrupting Navigation**: Clicking any step card jumps directly to its code without interrupting ongoing voice playback; click **Ask Agent (`问 Agent`)** to ask specifically about that step.
- **Responsive Layout**: Auto-expands on wide panes (`≥680px`) and auto-collapses on narrow splits, with a toolbar toggle (`调用链`) and drag handle (`200–440px`).

### 5. Full-Duplex Voice, Pause/Resume & Auto-Dependency Setup
- **Extension Host Native Microphone**: Uses `sox` / `rec`, macOS Swift `AVAudioEngine`, or Linux `arecord` directly in the Extension Host—bypassing VS Code Webview microphone permission blocks.
- **Two Voice Modes**:
  - **Full-Duplex VAD**: Speak anytime to barge in immediately (`session/cancel` + `<interruption_context>` snapshot capturing what was already spoken vs. cut off).
  - **Push-to-Talk (PTT)**: Hold **`Option` (`Alt`)** to speak and release to transcribe.
- **Zero-Config Speech + Cloud Slots**: Edge Neural TTS (`msedge-tts`) with offline macOS `say` fallback, local `whisper-cli` (`ggml-small-q5_1.bin` with auto HuggingFace/mirror download), plus OpenAI-compatible cloud TTS/STT support.
- **Auto-Install Dependencies**: Automatically checks and offers/installs missing `sox`, `whisper-cpp`, `ggml-small-q5_1.bin`, and npm-backed ACP CLIs (`reviewAgents.setup.autoInstallDependencies`, enabled by default).

### 6. Automatic Action Notes, Live Activity Bar & Telemetry
- **Automatic Action / Review Notes**: Recognizes spoken or typed action intent (including common Chinese ASR homophones) and captures `<review_note severity="action|issue|warning|info">` entries into inline VS Code Comment Threads and the Whiteboard **Notes Drawer**, ready to export as Markdown checklists (`- [ ] **[ACTION]**`) or publish to Bitbucket.
- **Live Agent Activity Bar & Stall Detection**: Displays real-time agent thoughts, files being read (`fs/read_text_file`), audio synthesis counters, and triggers a 15-second stall alert with an interrupt button.
- **Structured JSONL Telemetry**: Logs turn latency (`ttftMs`, `firstAudioMs`), token usage, barge-ins, and errors to VS Code `globalStorage/logs`.

---

## Prerequisites

- **VS Code** `^1.93.0`
- **Node.js** `20+` (for building from source)
- At least one **ACP-compatible agent CLI** installed on your `PATH`:
  - `agy` (default: `agy acp --sandbox`)
  - `claude-code-acp`
  - `codex-acp`
  - `gemini` (`gemini --experimental-acp`)
  - or any custom ACP server via `reviewAgents.acp.profile = "custom"`
- *(Optional for local voice on macOS/Linux)*: `sox` and `whisper-cpp` (auto-installed on startup when Homebrew is available, or run **`Review Agents: Check & Auto-Install Dependencies (CLI & Models)`**).

---

## Quick Start & Installation

### Build & Install Locally (Recommended)

```bash
git clone https://github.com/zzxzz12345/review-agents.git
cd review-agents
npm run install:all
npm run build
npx --yes @vscode/vsce package --no-dependencies -o review-agents-0.1.0.vsix
code --install-extension review-agents-0.1.0.vsix --force
```

Then reload VS Code (**`Developer: Reload Window`**) and launch via:
- Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → **`Review Agents: Explore / Review Current Branch (No PR)`**
- Or **`Review Agents: Start Voice & Whiteboard Review`** (or click **`Review Agents`** in the bottom-left status bar).

### Run in Extension Development Host

Open this repository in VS Code, run `npm run install:all && npm run build`, and press **`F5`**.

---

## Keyboard Shortcuts & Controls

| Shortcut / Action | Behavior |
| :--- | :--- |
| **`Space`** | **Pause / Resume** voice walkthrough and automatic code jumps (ignored while typing in text inputs) |
| **Hold `Option` (`Alt`)** | **Push-to-Talk (PTT)** when voice mode is set to `PTT` (release to transcribe & send) |
| **Speak anytime** | **Full-Duplex VAD Barge-In** when voice mode is set to `VAD` |
| **Click diagram node** | Select node context (`<selected_node>`) for your next question |
| **Double-click diagram node** | Jump directly to mapped source code |
| **Two-finger scroll / Pinch** | Pan and zoom the Mermaid whiteboard |
| **Click Call-Chain card** | Jump to step source (≤10 lines centered) **without** interrupting playback |

---

## Commands

| Command ID | Title | Description |
| :--- | :--- | :--- |
| `reviewAgents.exploreCurrentBranch` | `Review Agents: Explore / Review Current Branch (No PR)` | Start instruction-driven review, L1 overview, or standby on the current branch |
| `reviewAgents.startReview` | `Review Agents: Start Voice & Whiteboard Review` | Choose Current Branch Explore, Local Git Diff, or Bitbucket PR |
| `reviewAgents.openWhiteboard` | `Review Agents: Open/Focus Whiteboard` | Open or focus the Whiteboard panel |
| `reviewAgents.popOutWhiteboard` | `Review Agents: Pop Out Whiteboard to New Window` | Pop the Whiteboard out into a floating window |
| `reviewAgents.togglePause` | `Review Agents: Pause / Resume Walkthrough` | Toggle pause/resume playback and code sync |
| `reviewAgents.toggleViewMode` | `Review Agents: Toggle Diff / Source View` | Toggle between Diff and Source View (persisted preference) |
| `reviewAgents.publishDraftNotes` | `Review Agents: Publish Draft Notes to Bitbucket PR` | Batch-publish draft notes to Bitbucket PR |
| `reviewAgents.exportReport` | `Review Agents: Export Markdown Review Report` | Export Mermaid diagrams + review/action checklist as Markdown |
| `reviewAgents.configureBitbucketToken` | `Review Agents: Configure Bitbucket Credentials` | Store Bitbucket credentials securely in VS Code SecretStorage |
| `reviewAgents.configureSpeechApiKey` | `Review Agents: Configure Speech Provider API Key` | Store OpenAI-compatible cloud TTS/STT API key in SecretStorage |
| `reviewAgents.checkAndInstallDependencies` | `Review Agents: Check & Auto-Install Dependencies (CLI & Models)` | Check & auto-install `sox`, `whisper-cpp`, Whisper model, and ACP CLIs |
| `reviewAgents.downloadWhisperModel` | `Review Agents: Download Local Whisper STT Model` | Download `ggml-small-q5_1.bin` (~181 MB) |
| `reviewAgents.openLogs` | `Review Agents: Open Usage Logs Folder` | Open JSONL telemetry directory |
| `reviewAgents.stopSession` | `Review Agents: End Review Session` | Stop the active session and clear highlights |

---

## Key Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `reviewAgents.acp.profile` | `"agy"` | ACP preset: `"agy"`, `"claude-code"`, `"codex"`, `"gemini"`, or `"custom"` |
| `reviewAgents.acp.preferredModel` | `"Gemini 4 Hydrogen, auto/claude-sonnet-5-5:low"` | Comma-separated preferred ACP models in priority order |
| `reviewAgents.acp.thoughtLevel` | `"low"` | Reasoning effort (`"low"`, `"medium"`, `"high"`) |
| `reviewAgents.speech.ttsProvider` | `"edge-neural"` | `"edge-neural"`, `"system-native"`, or `"openai-compat"` |
| `reviewAgents.speech.sttProvider` | `"system-native"` | `"system-native"` (`whisper-cli` / macOS speech) or `"openai-compat"` |
| `reviewAgents.speech.ttsVoice` | `"zh-CN-XiaoxiaoNeural"` | Neural voice identifier for TTS |
| `reviewAgents.speech.ttsRate` | `1.1` | Speech playback speed (`0.5`–`2.0`) |
| `reviewAgents.speech.sttLocale` | `"zh-CN"` | Locale hint for speech recognition |
| `reviewAgents.voice.interactionMode` | `"vad"` | `"vad"` (full-duplex barge-in) or `"ptt"` (hold `Option` / `Alt`) |
| `reviewAgents.setup.autoInstallDependencies` | `true` | Auto-install missing local CLIs and Whisper model |
| `reviewAgents.context.maxContextChars` | `12000` | Pre-analyzed Context Pack budget (`4000`–`120000`) |
| `reviewAgents.logging.enabled` | `true` | Enable structured JSONL usage telemetry |

---

## Development & Testing

```bash
npm run typecheck   # Typecheck Extension Host + Webview
CI=true npm test    # Run Vitest unit & integration suite
npm run build       # Bundle Extension Host (esbuild) + Webview (Vite)
```

> Set `LIVE_ACP_SMOKE=1` when running `npm test` to include live ACP CLI smoke verification.

## License

[MIT](LICENSE)
