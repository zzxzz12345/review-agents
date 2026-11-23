import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AcpClientManager } from './acp/AcpClientManager';
import { resolveAcpProfile } from './acp/profiles';
import type { AcpProfileId } from './acp/types';
import { BitbucketService } from './context/BitbucketService';
import { ContextPackBuilder } from './context/ContextPackBuilder';
import { GitService } from './context/GitService';
import type {
  BitbucketPrTarget,
  BitbucketRemoteInfo,
  BranchExploreTarget,
  CorePathEntryHint,
  LocalDiffTarget,
  ReviewTarget,
} from './context/types';
import {
  ReviewSession,
  type ReviewSessionRuntimeConfig,
} from './orchestrator/ReviewSession';
import type { CodeViewMode, SessionPhase, VoiceMode } from './shared/protocol';
import {
  DependencyManager,
  type DependencyCheckReport,
} from './setup/DependencyManager';
import {
  SPEECH_API_KEY_SECRET,
  SpeechRegistry,
  type SpeechConfigSnapshot,
} from './speech/SpeechRegistry';
import { HostMicRecorder } from './speech/mic/HostMicRecorder';
import { UsageLogger } from './telemetry/UsageLogger';
import { CallChainResolver } from './vscode-ui/CallChainResolver';
import { CodeNavigator } from './vscode-ui/CodeNavigator';
import {
  GitContentProvider,
  REVIEW_GIT_SCHEME,
  parseGitUri,
} from './vscode-ui/GitContentProvider';
import { ReviewComments } from './vscode-ui/ReviewComments';
import { WhiteboardPanel } from './vscode-ui/WhiteboardPanel';

const VIEW_MODE_STATE_KEY = 'reviewAgents.preferredViewMode';

let activeSession: ReviewSession | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const gitService = new GitService();
  const bitbucketService = new BitbucketService();
  const contextPackBuilder = new ContextPackBuilder(gitService);
  const gitContentProvider = new GitContentProvider(gitService);
  const whiteboardPanel = new WhiteboardPanel(context.extensionUri);
  const savedViewMode = context.globalState.get<CodeViewMode>(
    VIEW_MODE_STATE_KEY,
    'source'
  );
  const codeNavigator = new CodeNavigator(savedViewMode);
  const callChainResolver = new CallChainResolver();
  const reviewComments = new ReviewComments();
  const acpClient = new AcpClientManager();
  const outputChannel = vscode.window.createOutputChannel('Review Agents');
  const hostMicRecorder = new HostMicRecorder(context.globalStorageUri.fsPath);
  const dependencyManager = new DependencyManager({
    storageDir: context.globalStorageUri.fsPath,
  });

  const persistToggleViewMode = async (
    target: ReviewTarget | undefined
  ): Promise<CodeViewMode> => {
    if (target?.kind === 'branch-explore') {
      return 'source';
    }
    const nextMode = await codeNavigator.toggleViewMode(target, whiteboardPanel);
    await context.globalState.update(VIEW_MODE_STATE_KEY, nextMode);
    return nextMode;
  };

  const initialLogCfg = readLoggingConfig(context);
  const usageLogger = new UsageLogger({
    logDir: initialLogCfg.logDir,
    enabled: initialLogCfg.enabled,
    onLine: (line) => outputChannel.appendLine(line),
  });

  const initialSpeechCfg = readSpeechConfig();
  const speechRegistry = new SpeechRegistry(
    context.globalStorageUri.fsPath,
    context.secrets,
    initialSpeechCfg
  );
  void speechRegistry.configure(initialSpeechCfg);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'reviewAgents.startReview';
  updateStatusBar('idle');
  statusBarItem.show();

  const startSessionWithTarget = async (target: ReviewTarget): Promise<void> => {
    if (!activeSession) {
      return;
    }
    gitContentProvider.clearCache();
    await speechRegistry.configure(readSpeechConfig());
    usageLogger.configure(readLoggingConfig(context));
    activeSession.updateConfig(readRuntimeConfig());
    await activeSession.start(target);
  };

  const startReviewFlow = async (): Promise<void> => {
    try {
      const target = await pickReviewTarget(
        gitService,
        bitbucketService,
        context.secrets
      );
      if (!target) {
        return;
      }
      await startSessionWithTarget(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      usageLogger.log('session.error', { scope: 'startReviewFlow', message: msg });
      void vscode.window.showErrorMessage(`Review Agents 启动失败: ${msg}`);
      updateStatusBar('error');
    }
  };

  const startBranchExploreFlow = async (presetInstruction?: string): Promise<void> => {
    try {
      const folderPath = await resolveWorkspaceFolderPath();
      if (!folderPath) {
        return;
      }
      const target = await pickBranchExploreTarget(
        gitService,
        folderPath,
        presetInstruction
      );
      if (!target) {
        return;
      }
      await startSessionWithTarget(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      usageLogger.log('session.error', {
        scope: 'startBranchExploreFlow',
        message: msg,
      });
      void vscode.window.showErrorMessage(`当前分支导读启动失败: ${msg}`);
      updateStatusBar('error');
    }
  };

  const startCorePathReviewFlow = async (presetInput?: string): Promise<void> => {
    try {
      const folderPath = await resolveWorkspaceFolderPath();
      if (!folderPath) {
        return;
      }
      const target = await pickCorePathReviewTarget(
        gitService,
        folderPath,
        presetInput
      );
      if (!target) {
        return;
      }
      await startSessionWithTarget(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      usageLogger.log('session.error', {
        scope: 'startCorePathReviewFlow',
        message: msg,
      });
      void vscode.window.showErrorMessage(`核心链路逐行 Review 启动失败: ${msg}`);
      updateStatusBar('error');
    }
  };

  const publishOrExportNotes = async (): Promise<void> => {
    if (!activeSession?.currentTarget) {
      void vscode.window.showInformationMessage('请先启动一个 Review 会话。');
      return;
    }
    const target = activeSession.currentTarget;
    const drafts = reviewComments.listDrafts();

    const choices: Array<{ label: string; description: string; action: 'publish' | 'export' }> = [];
    if (target.kind === 'bitbucket-pr') {
      choices.push({
        label: '$(cloud-upload) Publish Draft Notes to Bitbucket PR',
        description: `${drafts.filter((d) => !d.published).length} unpublished draft(s)`,
        action: 'publish',
      });
    }
    choices.push({
      label: '$(markdown) Export Markdown Review Report',
      description: 'Includes Mermaid diagrams and all review notes',
      action: 'export',
    });

    const picked = await vscode.window.showQuickPick(choices, {
      title: 'Review Notes Delivery',
    });
    if (!picked) {
      return;
    }

    if (picked.action === 'publish' && target.kind === 'bitbucket-pr') {
      const auth = await ensureBitbucketAuth(
        bitbucketService,
        context.secrets,
        target.remote.baseUrl
      );
      if (!auth) {
        return;
      }
      const res = await reviewComments.publishDraftsToBitbucket(
        bitbucketService,
        target,
        auth
      );
      usageLogger.log('notes.bitbucket_published', {
        prId: target.pr.id,
        publishedCount: res.publishedCount,
      });
      void vscode.window.showInformationMessage(
        `已成功发布 ${res.publishedCount} 条评论到 Bitbucket PR #${target.pr.id}。`
      );
    } else {
      await reviewComments.exportMarkdownReport(
        target,
        activeSession.currentContextPack,
        activeSession.collectedDiagrams
      );
      usageLogger.log('notes.markdown_exported', {
        draftCount: drafts.length,
      });
    }
  };

  let downloadingWhisperModel = false;
  const downloadWhisperModelFlow = async (): Promise<void> => {
    if (downloadingWhisperModel) {
      void vscode.window.showInformationMessage('Whisper 本地语音模型正在下载中...');
      return;
    }
    downloadingWhisperModel = true;
    try {
      const savedPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在下载离线 Whisper 语音模型 (ggml-small-q5_1.bin ~181MB)',
          cancellable: true,
        },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          let lastPct = 0;
          return speechRegistry.downloadDefaultWhisperModel((pct, dlMb, totalMb) => {
            const delta = Math.max(0, pct - lastPct);
            lastPct = pct;
            progress.report({
              increment: delta,
              message: `${dlMb.toFixed(1)} / ${totalMb.toFixed(1)} MB (${pct}%)`,
            });
          }, ac.signal);
        }
      );
      usageLogger.log('stt.whisper_model_downloaded', { savedPath });
      void vscode.window.showInformationMessage(
        `离线 Whisper 语音模型已下载就绪：${path.basename(savedPath)}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Whisper 模型下载失败: ${msg}`);
    } finally {
      downloadingWhisperModel = false;
    }
  };

  const promptSttModelMissing = async (): Promise<void> => {
    const choice = await vscode.window.showWarningMessage(
      '本地语音转文字 (whisper-cli) 尚未下载模型文件 (ggml-small-q5_1.bin ~181MB)，语音提问需要先下载离线模型或配置云端 STT API Key。',
      '下载离线 Whisper 模型 (~181MB)',
      '配置云端 STT API Key'
    );
    if (choice === '下载离线 Whisper 模型 (~181MB)') {
      await downloadWhisperModelFlow();
    } else if (choice === '配置云端 STT API Key') {
      await vscode.commands.executeCommand('reviewAgents.configureSpeechApiKey');
    }
  };

  let activeInstallPromise: Promise<boolean> | null = null;
  const ensureDependenciesFlow = async (opts: {
    interactive: boolean;
    onlyVoice?: boolean;
  }): Promise<boolean> => {
    if (activeInstallPromise) {
      return activeInstallPromise;
    }

    const run = async (): Promise<boolean> => {
      const runtimeCfg = readRuntimeConfig();
      const speechCfg = readSpeechConfig();
      const autoInstallEnabled = vscode.workspace
        .getConfiguration('reviewAgents')
        .get<boolean>('setup.autoInstallDependencies', true);

      const fullReport = await dependencyManager.checkDependencies({
        acpProfile: runtimeCfg.acpProfile,
        sttProvider: speechCfg.sttProvider,
        whisperModelPath: speechCfg.whisperModelPath,
      });

      const isVoiceItem = (id: string) =>
        id === 'mic-cli' || id === 'whisper-cli' || id === 'whisper-model';
      const filteredItems = opts.onlyVoice
        ? fullReport.items.filter((i) => isVoiceItem(i.id))
        : fullReport.items;
      const report: DependencyCheckReport = {
        ...fullReport,
        items: filteredItems,
        missingAutoInstallable: filteredItems.filter(
          (i) => !i.installed && i.autoInstallable
        ),
        missingManual: filteredItems.filter((i) => !i.installed && !i.autoInstallable),
      };

      usageLogger.log('deps.check', {
        onlyVoice: Boolean(opts.onlyVoice),
        missingAuto: report.missingAutoInstallable.map((i) => i.id),
        missingManual: report.missingManual.map((i) => i.id),
      });

      if (
        report.missingAutoInstallable.length === 0 &&
        report.missingManual.length === 0
      ) {
        if (opts.interactive) {
          void vscode.window.showInformationMessage(
            'Review Agents 所有 CLI 与语音模型依赖均已就绪！'
          );
        }
        return true;
      }

      if (
        report.missingManual.length > 0 &&
        (opts.interactive || report.missingAutoInstallable.length === 0)
      ) {
        const manualText = report.missingManual
          .map((i) => `${i.label}: ${i.manualHint ?? '请手动安装'}`)
          .join('；');
        void vscode.window.showWarningMessage(
          `Review Agents 存在需手动安装的依赖：${manualText}`
        );
      }

      if (report.missingAutoInstallable.length === 0) {
        return report.missingManual.length === 0;
      }

      if (!autoInstallEnabled && !opts.interactive) {
        const names = report.missingAutoInstallable.map((i) => i.label).join('、');
        const picked = await vscode.window.showInformationMessage(
          `检测到缺少 Review Agents 依赖：${names}`,
          '一键自动安装缺失依赖'
        );
        if (picked === '一键自动安装缺失依赖') {
          return runInstallProgress(report);
        }
        return false;
      }

      return runInstallProgress(report);
    };

    const runInstallProgress = async (
      report: DependencyCheckReport
    ): Promise<boolean> => {
      const names = report.missingAutoInstallable.map((i) => i.label).join('、');
      if (whiteboardPanel.visible) {
        whiteboardPanel.postMessage({
          type: 'notice:toast',
          level: 'info',
          message: `正在自动安装缺失依赖：${names}`,
        });
      }

      const installRes = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Review Agents: 正在自动安装缺失依赖 (${report.missingAutoInstallable.length} 项)`,
          cancellable: true,
        },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return dependencyManager.installMissing(
            report,
            (ev) => {
              progress.report({ message: `${ev.label}: ${ev.message}` });
              outputChannel.appendLine(`[deps] ${ev.label}: ${ev.message}`);
            },
            ac.signal
          );
        }
      );

      usageLogger.log('deps.install', {
        installed: installRes.installed,
        failed: installRes.failed,
      });

      if (installRes.installed.length > 0) {
        await speechRegistry.configure(readSpeechConfig());
      }

      if (installRes.failed.length === 0) {
        if (whiteboardPanel.visible) {
          whiteboardPanel.postMessage({
            type: 'notice:toast',
            level: 'info',
            message: '依赖自动安装完成，语音与 CLI 已就绪！',
          });
        }
        void vscode.window.showInformationMessage(
          `Review Agents 依赖自动安装完成（${installRes.installed.length} 项）。`
        );
        return true;
      }

      const failText = installRes.failed
        .map((f) => `${f.label} (${f.error})`)
        .join('；');
      void vscode.window.showErrorMessage(`部分依赖自动安装失败: ${failText}`);
      return false;
    };

    activeInstallPromise = run().finally(() => {
      activeInstallPromise = null;
    });
    return activeInstallPromise;
  };

  activeSession = new ReviewSession(
    {
      acpClient,
      contextPackBuilder,
      speech: {
        synthesizeWithFallback: (text, opts, onWarn) =>
          speechRegistry.synthesizeWithFallback(text, opts, onWarn),
        transcribe: (wav, locale, sig) =>
          speechRegistry.transcribe(wav, locale, sig),
        checkSttReadiness: () => speechRegistry.checkSttReadiness(),
      },
      mic: {
        start: (callbacks, options) => hostMicRecorder.start(callbacks, options),
        stop: () => hostMicRecorder.stop(),
        isActive: () => hostMicRecorder.isActive(),
        setVoiceMode: (mode) => hostMicRecorder.setVoiceMode(mode),
        setAssistantSpeaking: (speaking) => hostMicRecorder.setAssistantSpeaking(speaking),
        setVadConfig: (bargeInMs, silenceMs) => hostMicRecorder.setVadConfig(bargeInMs, silenceMs),
        startPtt: () => hostMicRecorder.startPtt(),
        endPtt: () => hostMicRecorder.endPtt(),
      },
      whiteboard: {
        openOrReveal: () => whiteboardPanel.openOrReveal(vscode.ViewColumn.One),
        popOutToWindow: () => whiteboardPanel.popOutToWindow(),
        postMessage: (msg) => whiteboardPanel.postMessage(msg),
        getPoppedOut: () => whiteboardPanel.poppedOut,
      },
      codeNavigator: {
        navigateTo: (cmd, target, opts) =>
          codeNavigator.navigateTo(cmd, target, whiteboardPanel, opts),
        toggleViewMode: (target) => persistToggleViewMode(target),
        getCurrentViewMode: () => codeNavigator.currentViewMode,
        getCurrentLocation: () => codeNavigator.currentLocation,
      },
      comments: reviewComments,
      callChainResolver,
      actions: {
        onSwitchTarget: startReviewFlow,
        onStartBranchExplore: () => startBranchExploreFlow(),
        onStartCorePathReview: () => startCorePathReviewFlow(),
        onAutoStartBranchExplore: (instruction) => startBranchExploreFlow(instruction),
        getActiveEditorRelPath: (repoRoot) => {
          const editor = vscode.window.activeTextEditor;
          if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
          }
          const rel = path.relative(repoRoot, editor.document.uri.fsPath);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return undefined;
          }
          return rel.replace(/\\/g, '/');
        },
        onPublishOrExportNotes: publishOrExportNotes,
        onPhaseChanged: (phase, title, activitySummary) =>
          updateStatusBar(phase, title, activitySummary),
        onSttModelMissing: () => {
          void promptSttModelMissing();
        },
        onEnsureVoiceDependencies: () =>
          ensureDependenciesFlow({ interactive: false, onlyVoice: true }),
      },
      logger: usageLogger,
    },
    readRuntimeConfig()
  );

  const webviewMsgSub = whiteboardPanel.onMessage((msg) => {
    void activeSession?.handleWebviewMessage(msg);
  });

  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('reviewAgents')) {
      return;
    }
    const speechCfg = readSpeechConfig();
    void speechRegistry.configure(speechCfg);
    usageLogger.configure(readLoggingConfig(context));
    activeSession?.updateConfig(readRuntimeConfig());
  });

  const editorSwitchSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor || !activeSession?.currentTarget) {
      return;
    }
    const doc = editor.document;
    const repoRoot = activeSession.currentTarget.repoRoot;
    let relPath: string | undefined;

    if (doc.uri.scheme === REVIEW_GIT_SCHEME) {
      const parsed = parseGitUri(doc.uri);
      if (parsed && path.resolve(parsed.repoRoot) === path.resolve(repoRoot)) {
        relPath = parsed.relPath;
      }
    } else if (doc.uri.scheme === 'file') {
      const rel = path.relative(repoRoot, doc.uri.fsPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        relPath = rel.replace(/\\/g, '/');
      }
    }

    if (!relPath || codeNavigator.isRecentProgrammaticNavigation(relPath)) {
      return;
    }

    activeSession.handleManualEditorSwitch(
      relPath,
      editor.selection.active.line + 1
    );
  });

  const autoInstallStartupEnabled = vscode.workspace
    .getConfiguration('reviewAgents')
    .get<boolean>('setup.autoInstallDependencies', true);
  const startupDepTimer = autoInstallStartupEnabled
    ? setTimeout(() => {
        void ensureDependenciesFlow({ interactive: false });
      }, 1500)
    : undefined;

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    gitContentProvider,
    codeNavigator,
    reviewComments,
    whiteboardPanel,
    webviewMsgSub,
    configSub,
    editorSwitchSub,
    vscode.workspace.registerTextDocumentContentProvider(
      REVIEW_GIT_SCHEME,
      gitContentProvider
    ),
    vscode.commands.registerCommand('reviewAgents.startReview', startReviewFlow),
    vscode.commands.registerCommand('reviewAgents.exploreCurrentBranch', () =>
      startBranchExploreFlow()
    ),
    vscode.commands.registerCommand('reviewAgents.corePathLineReview', () =>
      startCorePathReviewFlow()
    ),
    vscode.commands.registerCommand('reviewAgents.openWhiteboard', () => {
      whiteboardPanel.openOrReveal(vscode.ViewColumn.One);
    }),
    vscode.commands.registerCommand('reviewAgents.popOutWhiteboard', async () => {
      await whiteboardPanel.popOutToWindow();
    }),
    vscode.commands.registerCommand('reviewAgents.toggleViewMode', async () => {
      await persistToggleViewMode(activeSession?.currentTarget);
      if (activeSession) {
        activeSession.updateConfig(readRuntimeConfig());
      }
    }),
    vscode.commands.registerCommand('reviewAgents.togglePause', () => {
      activeSession?.togglePause();
    }),
    vscode.commands.registerCommand('reviewAgents.replayFromStart', () => {
      activeSession?.startReplay('from-start');
    }),
    vscode.commands.registerCommand('reviewAgents.configureBitbucketToken', async () => {
      await promptAndStoreBitbucketAuth(
        gitService,
        bitbucketService,
        context.secrets
      );
    }),
    vscode.commands.registerCommand('reviewAgents.configureSpeechApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'Configure Cloud Speech API Key',
        prompt: 'Enter your OpenAI / Compatible Speech API Key (leave empty to clear)',
        password: true,
      });
      if (apiKey === undefined) {
        return;
      }
      if (!apiKey.trim()) {
        await context.secrets.delete(SPEECH_API_KEY_SECRET);
        void vscode.window.showInformationMessage('Cleared Cloud Speech API Key.');
      } else {
        await context.secrets.store(SPEECH_API_KEY_SECRET, apiKey.trim());
        void vscode.window.showInformationMessage('Saved Cloud Speech API Key securely.');
      }
      await speechRegistry.configure(readSpeechConfig());
    }),
    vscode.commands.registerCommand('reviewAgents.publishDraftNotes', async () => {
      if (!activeSession?.currentTarget) {
        void vscode.window.showInformationMessage('No active review target.');
        return;
      }
      if (activeSession.currentTarget.kind !== 'bitbucket-pr') {
        void vscode.window.showInformationMessage(
          'Current target is not a Bitbucket PR. Use "Export Markdown Review Report" instead.'
        );
        return;
      }
      const auth = await ensureBitbucketAuth(
        bitbucketService,
        context.secrets,
        activeSession.currentTarget.remote.baseUrl
      );
      if (!auth) {
        return;
      }
      const res = await reviewComments.publishDraftsToBitbucket(
        bitbucketService,
        activeSession.currentTarget,
        auth
      );
      usageLogger.log('notes.bitbucket_published', {
        prId: activeSession.currentTarget.pr.id,
        publishedCount: res.publishedCount,
      });
      void vscode.window.showInformationMessage(
        `Published ${res.publishedCount} comment(s) to Bitbucket PR.`
      );
    }),
    vscode.commands.registerCommand('reviewAgents.exportReport', async () => {
      if (!activeSession?.currentTarget) {
        void vscode.window.showInformationMessage('No active review session.');
        return;
      }
      await reviewComments.exportMarkdownReport(
        activeSession.currentTarget,
        activeSession.currentContextPack,
        activeSession.collectedDiagrams
      );
      usageLogger.log('notes.markdown_exported', {
        draftCount: reviewComments.listDrafts().length,
      });
    }),
    vscode.commands.registerCommand('reviewAgents.stopSession', async () => {
      activeSession?.dispose();
      await usageLogger.dispose();
      codeNavigator.clearAllHighlights();
      updateStatusBar('idle');
      void vscode.window.showInformationMessage('Review Agents session ended.');
    }),
    vscode.commands.registerCommand('reviewAgents.openLogs', async () => {
      const logDir = usageLogger.getLogDirectory();
      await fs.mkdir(logDir, { recursive: true });
      await usageLogger.flush();
      await vscode.env.openExternal(vscode.Uri.file(logDir));
      const activeLog = usageLogger.getCurrentLogPath();
      const info = activeLog
        ? `Current usage log: ${activeLog}`
        : `Usage logs folder: ${logDir}`;
      const choice = await vscode.window.showInformationMessage(info, 'Show Output Channel');
      if (choice === 'Show Output Channel') {
        outputChannel.show(true);
      }
    }),
    vscode.commands.registerCommand(
      'reviewAgents.downloadWhisperModel',
      downloadWhisperModelFlow
    ),
    vscode.commands.registerCommand(
      'reviewAgents.checkAndInstallDependencies',
      () => ensureDependenciesFlow({ interactive: true })
    ),
    {
      dispose: () => {
        if (startupDepTimer) {
          clearTimeout(startupDepTimer);
        }
        hostMicRecorder.dispose();
        activeSession?.dispose();
        speechRegistry.dispose();
        void usageLogger.dispose();
      },
    }
  );
}

export function deactivate(): void {
  activeSession?.dispose();
  activeSession = undefined;
}

function readSpeechConfig(): SpeechConfigSnapshot {
  const cfg = vscode.workspace.getConfiguration('reviewAgents');
  return {
    ttsProvider: cfg.get<'edge-neural' | 'system-native' | 'openai-compat'>(
      'speech.ttsProvider',
      'edge-neural'
    ),
    sttProvider: cfg.get<'system-native' | 'openai-compat'>(
      'speech.sttProvider',
      'system-native'
    ),
    ttsVoice: cfg.get<string>('speech.ttsVoice', 'zh-CN-XiaoxiaoNeural'),
    ttsRate: cfg.get<number>('speech.ttsRate', 1.1),
    sttLocale: cfg.get<string>('speech.sttLocale', 'zh-CN'),
    whisperModelPath: cfg.get<string>('speech.whisperModelPath', ''),
    cloudBaseUrl: cfg.get<string>('speech.cloudBaseUrl', 'https://api.openai.com/v1'),
    cloudTtsModel: cfg.get<string>('speech.cloudTtsModel', 'tts-1'),
    cloudSttModel: cfg.get<string>('speech.cloudSttModel', 'whisper-1'),
  };
}

function readLoggingConfig(context: vscode.ExtensionContext): {
  enabled: boolean;
  logDir: string;
} {
  const cfg = vscode.workspace.getConfiguration('reviewAgents');
  const enabled = cfg.get<boolean>('logging.enabled', true);
  const customDir = cfg.get<string>('logging.directory', '').trim();
  return {
    enabled,
    logDir: customDir || path.join(context.globalStorageUri.fsPath, 'logs'),
  };
}

function readRuntimeConfig(): ReviewSessionRuntimeConfig {
  const cfg = vscode.workspace.getConfiguration('reviewAgents');
  const profileId = cfg.get<AcpProfileId>('acp.profile', 'agy');
  const acpProfile = resolveAcpProfile({
    profile: profileId,
    customCommand: cfg.get<string>('acp.command', ''),
    customArgs: cfg.get<string[]>('acp.args', []),
  });

  return {
    acpProfile,
    thoughtLevel: cfg.get<'low' | 'medium' | 'high'>('acp.thoughtLevel', 'low'),
    preferredModel: cfg.get<string>(
      'acp.preferredModel',
      'Gemini 4 Hydrogen, auto/claude-sonnet-5-5:low'
    ),
    ttsVoice: cfg.get<string>('speech.ttsVoice', 'zh-CN-XiaoxiaoNeural'),
    ttsRate: cfg.get<number>('speech.ttsRate', 1.1),
    sttLocale: cfg.get<string>('speech.sttLocale', 'zh-CN'),
    voiceMode: cfg.get<VoiceMode>('voice.interactionMode', 'vad'),
    vadBargeInMs: cfg.get<number>('voice.vadBargeInMs', 300),
    vadSilenceMs: cfg.get<number>('voice.vadSilenceMs', 900),
    maxContextChars: cfg.get<number>('context.maxContextChars', 12000),
    ignorePatterns: cfg.get<string[]>('context.ignorePatterns', []),
    autoContinue: cfg.get<boolean>('walkthrough.autoContinue', true),
  };
}

function updateStatusBar(
  phase: SessionPhase,
  targetTitle?: string,
  activitySummary?: string
): void {
  if (!statusBarItem) {
    return;
  }
  const icons: Record<SessionPhase, string> = {
    idle: '$(comment-discussion)',
    analyzing: '$(sync~spin)',
    connecting: '$(sync~spin)',
    thinking: '$(loading~spin)',
    speaking: '$(unmute)',
    listening: '$(mic)',
    paused: '$(debug-pause)',
    error: '$(error)',
  };
  const compactSummary =
    activitySummary && activitySummary.trim()
      ? activitySummary.trim().length > 42
        ? `${activitySummary.trim().slice(0, 39)}...`
        : activitySummary.trim()
      : undefined;
  const label = compactSummary
    ? `Review: ${compactSummary}`
    : targetTitle
      ? `Review: ${targetTitle}`
      : 'Review Agents';
  statusBarItem.text = `${icons[phase]} ${label}`;
  const tooltipParts = [`Review Agents (${phase})`];
  if (targetTitle) {
    tooltipParts.push(targetTitle);
  }
  if (activitySummary) {
    tooltipParts.push(activitySummary);
  }
  tooltipParts.push('点击启动当前分支导读或切换 PR / Diff');
  statusBarItem.tooltip = tooltipParts.join(' · ');
}

async function resolveWorkspaceFolderPath(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('请先打开一个项目或 Git 仓库工作区。');
    return undefined;
  }

  let selectedFolder = folders[0];
  if (folders.length > 1) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri
      ? vscode.workspace.getWorkspaceFolder(activeUri)
      : undefined;
    if (activeFolder) {
      selectedFolder = activeFolder;
    } else {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'Select project workspace for Review Agents',
      });
      if (!picked) {
        return undefined;
      }
      selectedFolder = picked;
    }
  }

  return selectedFolder.uri.fsPath;
}

function captureActiveEditorEntryHint(repoRoot: string): CorePathEntryHint | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const rel = path.relative(repoRoot, editor.document.uri.fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  const normalizedFile = rel.replace(/\\/g, '/');
  const sel = editor.selection;
  const line = sel.active.line + 1;
  let endLine: number | undefined;
  let selectedSnippet: string | undefined;

  if (!sel.isEmpty) {
    const startLine = Math.min(sel.start.line, sel.end.line) + 1;
    endLine = Math.max(sel.start.line, sel.end.line) + 1;
    const raw = editor.document.getText(sel).trim();
    if (raw) {
      selectedSnippet = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    }
    return {
      file: normalizedFile,
      line: startLine,
      endLine,
      selectedSnippet,
    };
  }

  const cursorLineText = editor.document.lineAt(sel.active.line).text.trim();
  return {
    file: normalizedFile,
    line,
    selectedSnippet: cursorLineText ? cursorLineText.slice(0, 200) : undefined,
  };
}

async function pickCorePathReviewTarget(
  gitService: GitService,
  folderPath: string,
  presetInput?: string
): Promise<BranchExploreTarget | undefined> {
  const { repoRoot, isGitRepo } = await gitService.getRepoRootOrFallback(folderPath);
  const projectName = path.basename(repoRoot) || 'workspace';
  const branchName = isGitRepo
    ? await gitService.getCurrentBranch(repoRoot)
    : projectName;
  const entryHint = captureActiveEditorEntryHint(repoRoot);

  let userInput = presetInput?.trim() ?? '';
  if (!userInput) {
    const hintPlaceholder = entryHint
      ? `（当前光标位于 ${entryHint.file}:${entryHint.line}，直接回车将从此处开始）`
      : '例如：用户输入提问 -> ReviewSession.handleUserQuestion / 下单接口 POST /orders 扣库存链路';
    const raw = await vscode.window.showInputBox({
      title: `基于输入的核心链路逐行 Review (${branchName})`,
      prompt: '输入想逐行追踪的业务入口、接口、方法或输入场景（每次看几行核心分支/调用，自动跳入子方法并按需深化白板）',
      placeHolder: hintPlaceholder,
      value: entryHint ? `${entryHint.file}:${entryHint.line} ` : '',
    });
    if (raw === undefined) {
      return undefined;
    }
    userInput = raw.trim();
    if (!userInput) {
      if (entryHint) {
        userInput = `从当前光标位置 ${entryHint.file}:${entryHint.line} 开始核心链路逐行 Review`;
      } else {
        void vscode.window.showInformationMessage(
          '请输入要追踪的入口方法、场景或先在编辑器中打开一个源文件。'
        );
        return undefined;
      }
    }
  }

  const shortInput =
    userInput.length > 44 ? `${userInput.slice(0, 44)}...` : userInput;

  return {
    kind: 'branch-explore',
    repoRoot,
    branchName,
    baseRef: 'HEAD',
    effectiveBaseRef: 'HEAD',
    headRef: 'HEAD',
    title: `${projectName} (${branchName})`,
    subtitle: `核心链路逐行 Review · ${shortInput}`,
    initialInstruction: userInput,
    startMode: 'core-path-line-review',
    entryHint,
  };
}

async function pickBranchExploreTarget(
  gitService: GitService,
  folderPath: string,
  presetInstruction?: string
): Promise<BranchExploreTarget | undefined> {
  const { repoRoot, isGitRepo } = await gitService.getRepoRootOrFallback(folderPath);
  const projectName = path.basename(repoRoot) || 'workspace';
  const branchName = isGitRepo
    ? await gitService.getCurrentBranch(repoRoot)
    : projectName;

  if (presetInstruction?.trim()) {
    const cleanInst = presetInstruction.trim();
    const shortInst =
      cleanInst.length > 48 ? `${cleanInst.slice(0, 48)}...` : cleanInst;
    return {
      kind: 'branch-explore',
      repoRoot,
      branchName,
      baseRef: 'HEAD',
      effectiveBaseRef: 'HEAD',
      headRef: 'HEAD',
      title: `${projectName} (${branchName})`,
      subtitle: `当前分支指令导读 · ${shortInst}`,
      initialInstruction: cleanInst,
      startMode: 'instruction',
    };
  }

  const startPick = await vscode.window.showQuickPick(
    [
      {
        label: '$(list-tree) 基于输入的核心链路逐行 Review（逐段看核心分支，自动跳子方法 + 深化白板）',
        description: '从你输入的入口或光标处逐行推演核心调用链',
        startMode: 'core-path-line-review' as const,
      },
      {
        label: '$(edit) 输入自定义指令（按需求 Review 指定模块 / 了解特定功能）',
        description: '推荐 · 指定你想深入的代码区域、链路或 Review 重点',
        startMode: 'instruction' as const,
      },
      {
        label: '$(map) 自动梳理当前项目全局架构（L1 总览导读）',
        description: `直接基于 ${branchName} 分支生成全局架构白板并定位入口`,
        startMode: 'auto-overview' as const,
      },
      {
        label: '$(mic) 直接连接待命（打开白板后由我语音 / 打字下达指令）',
        description: '立即就绪，不先播放全局介绍',
        startMode: 'standby' as const,
      },
    ],
    {
      title: `当前分支导读 / Review (${branchName})`,
      placeHolder: '无需选 PR，选择基于当前分支的启动方式',
    }
  );

  if (!startPick) {
    return undefined;
  }

  if (startPick.startMode === 'core-path-line-review') {
    return pickCorePathReviewTarget(gitService, folderPath);
  }

  let initialInstruction: string | undefined;
  let effectiveStartMode = startPick.startMode;

  if (startPick.startMode === 'instruction') {
    const rawInput = await vscode.window.showInputBox({
      title: `当前分支指令导读 / Review (${branchName})`,
      prompt: '输入想 Review 的模块/问题，或想了解的业务链路（直接回车则做全局架构导读）',
      placeHolder: '例如：帮我 Review 鉴权模块的安全边界 / 自顶向下讲解语音交互主链路',
    });
    if (rawInput === undefined) {
      return undefined;
    }
    const trimmed = rawInput.trim();
    if (trimmed) {
      initialInstruction = trimmed;
    } else {
      effectiveStartMode = 'auto-overview';
    }
  }

  const subtitle = initialInstruction
    ? `当前分支指令 · ${
        initialInstruction.length > 48
          ? `${initialInstruction.slice(0, 48)}...`
          : initialInstruction
      }`
    : effectiveStartMode === 'standby'
      ? `当前分支待命中 · ${branchName}`
      : `当前分支全局架构导读 · ${branchName}`;

  return {
    kind: 'branch-explore',
    repoRoot,
    branchName,
    baseRef: 'HEAD',
    effectiveBaseRef: 'HEAD',
    headRef: 'HEAD',
    title: `${projectName} (${branchName})`,
    subtitle,
    initialInstruction,
    startMode: effectiveStartMode,
  };
}

async function pickReviewTarget(
  gitService: GitService,
  bitbucketService: BitbucketService,
  secrets: vscode.SecretStorage
): Promise<ReviewTarget | undefined> {
  const folderPath = await resolveWorkspaceFolderPath();
  if (!folderPath) {
    return undefined;
  }

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(list-tree) Core-Path Line-by-Line Review (基于输入的核心链路逐行 Review)',
        description: '指定入口或输入场景，逐行审核心分支与调用并自动跳入子方法深化白板',
        mode: 'core-path-line-review' as const,
      },
      {
        label: '$(compass) Current Branch / Project Review & Explore (无需选 PR)',
        description: '直接基于当前分支按指令 Review 指定代码或自顶向下了解项目',
        mode: 'branch-explore' as const,
      },
      {
        label: '$(git-compare) Local Git Branch / Commit Diff',
        description: 'Compare current branch or any two refs locally',
        mode: 'local' as const,
      },
      {
        label: '$(git-pull-request) Bitbucket Pull Request (Cloud / Data Center)',
        description: 'Fetch PR metadata & diff via Bitbucket REST API + local git',
        mode: 'bitbucket' as const,
      },
    ],
    {
      title: 'Review Agents: Choose Review Source',
      placeHolder: 'Select what you want the agent to walk you through',
    }
  );

  if (!modePick) {
    return undefined;
  }

  if (modePick.mode === 'core-path-line-review') {
    return pickCorePathReviewTarget(gitService, folderPath);
  }

  if (modePick.mode === 'branch-explore') {
    return pickBranchExploreTarget(gitService, folderPath);
  }

  let repoRoot: string;
  try {
    repoRoot = await gitService.getRepoRoot(folderPath);
  } catch {
    void vscode.window.showErrorMessage(
      '当前工作区不是 Git 仓库，请改用「Current Branch / Project Review & Explore」或打开 Git 仓库。'
    );
    return undefined;
  }

  if (modePick.mode === 'local') {
    return pickLocalDiffTarget(gitService, repoRoot);
  }
  return pickBitbucketPrTarget(gitService, bitbucketService, secrets, repoRoot);
}

async function pickLocalDiffTarget(
  gitService: GitService,
  repoRoot: string
): Promise<LocalDiffTarget | undefined> {
  const [currentBranch, refs] = await Promise.all([
    gitService.getCurrentBranch(repoRoot),
    gitService.listRefs(repoRoot),
  ]);

  const headItems = [
    {
      label: `$(git-branch) HEAD (${currentBranch})`,
      description: 'Current checked-out branch / commit',
      ref: 'HEAD',
    },
    ...refs.map((r) => ({
      label: r.name,
      description: `${r.kind} · ${r.sha}`,
      detail: r.subject,
      ref: r.name,
    })),
  ];

  const pickedHead = await vscode.window.showQuickPick(headItems, {
    title: 'Step 1/2: Select Head Branch / Commit (Your Changes)',
  });
  if (!pickedHead) {
    return undefined;
  }

  const defaultBaseNames = ['main', 'master', 'develop', 'origin/main', 'origin/master'];
  const sortedBaseRefs = [...refs].sort((a, b) => {
    const aIdx = defaultBaseNames.indexOf(a.name);
    const bIdx = defaultBaseNames.indexOf(b.name);
    if (aIdx !== -1 || bIdx !== -1) {
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    }
    return 0;
  });

  const pickedBase = await vscode.window.showQuickPick(
    sortedBaseRefs.map((r) => ({
      label: r.name,
      description: `${r.kind} · ${r.sha}`,
      detail: r.subject,
      ref: r.name,
    })),
    {
      title: `Step 2/2: Select Base Branch / Commit (Compare ${pickedHead.ref} against...)`,
    }
  );
  if (!pickedBase) {
    return undefined;
  }

  const effectiveBaseRef = await gitService.resolveMergeBase(
    repoRoot,
    pickedBase.ref,
    pickedHead.ref
  );

  return {
    kind: 'local-diff',
    repoRoot,
    baseRef: pickedBase.ref,
    effectiveBaseRef,
    headRef: pickedHead.ref,
    title: `${pickedHead.ref} vs ${pickedBase.ref}`,
    subtitle: `Local Diff · ${pickedBase.ref}..${pickedHead.ref}`,
  };
}

async function pickBitbucketPrTarget(
  gitService: GitService,
  bitbucketService: BitbucketService,
  secrets: vscode.SecretStorage,
  repoRoot: string
): Promise<BitbucketPrTarget | undefined> {
  const cfg = vscode.workspace.getConfiguration('reviewAgents');
  const serverOverride = cfg.get<string>('bitbucket.serverBaseUrl', '');
  const remotes = await gitService.getRemotes(repoRoot);

  let detectedRemote: BitbucketRemoteInfo | undefined;
  for (const r of remotes) {
    const parsed = bitbucketService.parseRemoteUrl(
      r.name,
      r.fetchUrl || r.pushUrl,
      serverOverride
    );
    if (parsed) {
      detectedRemote = parsed;
      break;
    }
  }

  const entryPick = await vscode.window.showQuickPick(
    [
      ...(detectedRemote
        ? [
            {
              label: `$(list-unordered) Browse Open PRs (${detectedRemote.workspaceOrProject}/${detectedRemote.repoSlug})`,
              description: detectedRemote.kind === 'cloud' ? 'Bitbucket Cloud' : 'Bitbucket Server/DC',
              entryMode: 'browse' as const,
            },
          ]
        : []),
      {
        label: '$(link) Enter Bitbucket PR URL or PR Number',
        description: 'Paste a Cloud or Data Center Pull Request link',
        entryMode: 'url' as const,
      },
    ],
    {
      title: 'Bitbucket Pull Request Source',
    }
  );

  if (!entryPick) {
    return undefined;
  }

  let targetRemote = detectedRemote;
  let prId: number | undefined;

  if (entryPick.entryMode === 'url') {
    const rawInput = await vscode.window.showInputBox({
      title: 'Bitbucket Pull Request URL or ID',
      placeHolder: 'https://bitbucket.org/workspace/repo/pull-requests/123 or 123',
    });
    if (!rawInput?.trim()) {
      return undefined;
    }
    const trimmed = rawInput.trim();
    if (/^\d+$/.test(trimmed)) {
      if (!targetRemote) {
        void vscode.window.showErrorMessage(
          'No Bitbucket remote detected from git remotes. Please paste the full PR URL.'
        );
        return undefined;
      }
      prId = Number.parseInt(trimmed, 10);
    } else {
      const parsedUrl = bitbucketService.parsePrUrl(trimmed);
      if (!parsedUrl) {
        void vscode.window.showErrorMessage('无法解析该 Bitbucket PR URL。');
        return undefined;
      }
      prId = parsedUrl.prId;
      targetRemote = {
        kind: parsedUrl.kind,
        remoteName: targetRemote?.remoteName ?? 'origin',
        baseUrl: parsedUrl.baseUrl,
        webBaseUrl:
          parsedUrl.kind === 'cloud' ? 'https://bitbucket.org' : parsedUrl.baseUrl,
        workspaceOrProject: parsedUrl.workspaceOrProject,
        repoSlug: parsedUrl.repoSlug,
      };
    }
  }

  if (!targetRemote) {
    return undefined;
  }

  let auth = await bitbucketService.getStoredAuth(secrets, targetRemote.baseUrl);
  if (!auth) {
    auth = await ensureBitbucketAuth(bitbucketService, secrets, targetRemote.baseUrl);
  }

  if (prId === undefined) {
    let prs;
    try {
      prs = await bitbucketService.listOpenPullRequests(targetRemote, auth);
    } catch (err) {
      auth = await promptAndStoreBitbucketAuth(
        gitService,
        bitbucketService,
        secrets,
        targetRemote.baseUrl
      );
      if (!auth) {
        return undefined;
      }
      prs = await bitbucketService.listOpenPullRequests(targetRemote, auth);
    }

    if (prs.length === 0) {
      void vscode.window.showInformationMessage('当前仓库没有 Open 状态的 Bitbucket PR。');
      return undefined;
    }

    const pickedPr = await vscode.window.showQuickPick(
      prs.map((pr) => ({
        label: `#${pr.id} ${pr.title}`,
        description: `${pr.sourceBranch} -> ${pr.targetBranch}`,
        detail: `Author: ${pr.author}`,
        pr,
      })),
      {
        title: 'Select Bitbucket Pull Request to Review',
      }
    );
    if (!pickedPr) {
      return undefined;
    }
    prId = pickedPr.pr.id;
  }

  let pr;
  try {
    pr = await bitbucketService.getPullRequest(targetRemote, prId, auth);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\((401|403|404)\)/.test(msg)) {
      const updatedAuth = await promptAndStoreBitbucketAuth(
        gitService,
        bitbucketService,
        secrets,
        targetRemote.baseUrl
      );
      if (!updatedAuth) {
        return undefined;
      }
      auth = updatedAuth;
      pr = await bitbucketService.getPullRequest(targetRemote, prId, auth);
    } else {
      throw err;
    }
  }

  // Fetch source and target commits/branches quietly so git show / diff work offline
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Fetching Git refs for Bitbucket PR #${pr.id}...`,
    },
    async () => {
      try {
        await gitService.fetchRefs(repoRoot, targetRemote!.remoteName, [
          pr.sourceCommit || pr.sourceBranch,
          pr.targetCommit || pr.targetBranch,
        ]);
      } catch {
        await gitService.fetchRefs(repoRoot, targetRemote!.remoteName, []).catch(() => undefined);
      }
    }
  );

  const headRef = pr.sourceCommit || `${targetRemote.remoteName}/${pr.sourceBranch}`;
  const baseRef = pr.targetCommit || `${targetRemote.remoteName}/${pr.targetBranch}`;
  const effectiveBaseRef = await gitService.resolveMergeBase(repoRoot, baseRef, headRef);

  return {
    kind: 'bitbucket-pr',
    repoRoot,
    baseRef,
    effectiveBaseRef,
    headRef,
    title: `PR #${pr.id}: ${pr.title}`,
    subtitle: `Bitbucket · ${pr.sourceBranch} -> ${pr.targetBranch} · by ${pr.author}`,
    remote: targetRemote,
    pr,
  };
}

async function ensureBitbucketAuth(
  bitbucketService: BitbucketService,
  secrets: vscode.SecretStorage,
  baseUrl: string
) {
  const existing = await bitbucketService.getStoredAuth(secrets, baseUrl);
  if (existing) {
    return existing;
  }
  return promptAndStoreBitbucketAuth(
    new GitService(),
    bitbucketService,
    secrets,
    baseUrl
  );
}

async function promptAndStoreBitbucketAuth(
  gitService: GitService,
  bitbucketService: BitbucketService,
  secrets: vscode.SecretStorage,
  presetBaseUrl?: string
) {
  let baseUrl = presetBaseUrl;
  if (!baseUrl) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders[0]) {
      try {
        const root = await gitService.getRepoRoot(folders[0].uri.fsPath);
        const remotes = await gitService.getRemotes(root);
        const override = vscode.workspace
          .getConfiguration('reviewAgents')
          .get<string>('bitbucket.serverBaseUrl', '');
        for (const r of remotes) {
          const parsed = bitbucketService.parseRemoteUrl(
            r.name,
            r.fetchUrl || r.pushUrl,
            override
          );
          if (parsed) {
            baseUrl = parsed.baseUrl;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
    baseUrl = await vscode.window.showInputBox({
      title: 'Bitbucket API Base URL',
      value: baseUrl || 'https://api.bitbucket.org/2.0',
      prompt: 'For Bitbucket Cloud use https://api.bitbucket.org/2.0; for Server/DC use https://your-bitbucket-host',
    });
    if (!baseUrl?.trim()) {
      return undefined;
    }
  }

  const username = await vscode.window.showInputBox({
    title: 'Bitbucket Username (Optional for Bearer Token)',
    prompt: 'Enter Bitbucket username if using App Password / Basic Auth, or leave empty for HTTP Access Token (Bearer)',
  });
  if (username === undefined) {
    return undefined;
  }

  const token = await vscode.window.showInputBox({
    title: 'Bitbucket Access Token / App Password',
    password: true,
    prompt: `Stored securely in VS Code SecretStorage for ${baseUrl}`,
  });
  if (!token?.trim()) {
    return undefined;
  }

  const auth = {
    username: username.trim() || undefined,
    token: token.trim(),
  };
  await bitbucketService.saveStoredAuth(secrets, baseUrl.trim(), auth);
  void vscode.window.showInformationMessage('Bitbucket credentials saved securely.');
  return auth;
}
