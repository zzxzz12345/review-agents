export type AcpProfileId = 'agy' | 'claude-code' | 'codex' | 'gemini' | 'custom';

export interface AcpProfile {
  id: AcpProfileId;
  displayName: string;
  command: string;
  args: string[];
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: AcpConfigOptionValue[];
}

export interface AcpModelInfo {
  modelId: string;
  name: string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    _meta?: {
      antigravity?: {
        tier?: boolean;
        systemPrompt?: {
          append?: boolean;
        };
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  agentInfo?: {
    name?: string;
    version?: string;
  };
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    availableModels?: AcpModelInfo[];
    currentModelId?: string;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id: string; name: string; description?: string }>;
  };
  configOptions?: AcpConfigOption[];
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
  options?: AcpPermissionOption[];
}

export interface AcpReadTextFileParams {
  sessionId?: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
}

export interface AcpToolActivityInfo {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  filePath?: string;
  line?: number;
  limit?: number;
  detail?: string;
}

export interface AcpPromptCallbacks {
  onTextDelta: (delta: string) => void;
  onThoughtDelta?: (delta: string) => void;
  onToolActivity?: (info: AcpToolActivityInfo) => void;
}

export interface AcpModelResolution {
  requestedModel?: string;
  matchedCandidate?: string;
  requestedThoughtLevel: string;
  resolvedModel: string;
  resolvedThoughtLevel: string;
  matchedRequestedModel: boolean;
  availableModels: string[];
}
