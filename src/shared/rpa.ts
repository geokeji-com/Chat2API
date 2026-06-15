export type RpaBrowser = 'chrome' | 'edge'

export type RpaProfileMode = 'dedicated' | 'existing-debug'

export type RpaProviderLearningTargetId = 'custom' | 'deepseek' | 'yuanbao' | 'doubao'

export interface RpaProviderLearningTarget {
  id: RpaProviderLearningTargetId
  name: string
  url: string
  description: string
  captureDomains: string[]
}

export const RPA_PROVIDER_LEARNING_TARGET_BY_PROVIDER_ID: Partial<Record<string, RpaProviderLearningTargetId>> = {
  deepseek: 'deepseek',
  yuanbao: 'yuanbao',
  doubao: 'doubao',
}

export const RPA_PROVIDER_LEARNING_TARGETS: RpaProviderLearningTarget[] = [
  {
    id: 'custom',
    name: 'Custom',
    url: '',
    description: 'Enter a provider URL manually',
    captureDomains: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    description: 'Capture DeepSeek chat, session, share, and proof-of-work traffic',
    captureDomains: ['deepseek.com'],
  },
  {
    id: 'yuanbao',
    name: 'Yuanbao',
    url: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    description: 'Capture Yuanbao chat, conversation, and upload traffic',
    captureDomains: ['tencent.com', 'myqcloud.com'],
  },
  {
    id: 'doubao',
    name: 'Doubao',
    url: 'https://www.doubao.com/chat/',
    description: 'Capture Doubao browser chat/completion traffic and injected signature query parameters',
    captureDomains: ['doubao.com'],
  },
]

export function getRpaLearningTargetById(id?: RpaProviderLearningTargetId): RpaProviderLearningTarget | undefined {
  if (!id || id === 'custom') {
    return undefined
  }

  return RPA_PROVIDER_LEARNING_TARGETS.find((target) => target.id === id)
}

export function getRpaLearningTargetForProvider(providerId?: string): RpaProviderLearningTarget | undefined {
  const targetId = providerId ? RPA_PROVIDER_LEARNING_TARGET_BY_PROVIDER_ID[providerId] : undefined
  return getRpaLearningTargetById(targetId)
}

export type RpaSessionStatus =
  | 'idle'
  | 'launching'
  | 'connected'
  | 'capturing'
  | 'classified'
  | 'patch-ready'
  | 'applied'
  | 'cancelled'
  | 'timeout'
  | 'error'

export interface RpaLaunchBrowserOptions {
  browser?: RpaBrowser
  port?: number
  profileMode?: RpaProfileMode
  url?: string
}

export interface RpaConnectBrowserOptions {
  host?: string
  port?: number
}

export interface RpaBrowserConnection {
  connected: boolean
  host: string
  port: number
  browser?: string
  profileDir?: string
  error?: string
}

export interface RpaTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface RpaStartLearningOptions {
  targetId: string
  learningTargetId?: RpaProviderLearningTargetId
  providerId?: string
  accountId?: string
  prompt?: string
  timeoutMs?: number
}

export type RpaAutoScenarioStep =
  | 'discover-browser'
  | 'open-target'
  | 'wait-login'
  | 'focus-input'
  | 'send-prompt'
  | 'wait-answer'
  | 'click-share'
  | 'wait-share-request'

export interface RpaStartAutoLearningOptions extends RpaStartLearningOptions {
  share?: boolean
  answerTimeoutMs?: number
  shareTimeoutMs?: number
  loginTimeoutMs?: number
}

export interface RpaStartRecordingOptions {
  learningTargetId?: RpaProviderLearningTargetId
  providerId?: string
  accountId?: string
  providerUrl?: string
  browser?: RpaBrowser
  port?: number
  timeoutMs?: number
}

export interface RpaAutoLearnProviderOptions {
  learningTargetId?: RpaProviderLearningTargetId
  providerId?: string
  accountId?: string
  providerUrl?: string
  browser?: RpaBrowser
  port?: number
  prompt?: string
  share?: boolean
  timeoutMs?: number
  answerTimeoutMs?: number
  shareTimeoutMs?: number
  loginTimeoutMs?: number
}

export interface RpaProgressEvent {
  status: RpaSessionStatus
  message: string
  sessionId?: string
  data?: Record<string, unknown>
}

export interface RpaAutomationStepResult {
  step: RpaAutoScenarioStep
  success: boolean
  message: string
  targetLabel?: string
  confidence?: number
}

export interface RpaCapturedRequest {
  id: string
  url: string
  method: string
  resourceType: string
  lifecycle?: 'started' | 'response' | 'completed' | 'failed'
  status?: number
  mimeType?: string
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  requestBody?: string
  responseBody?: string
  startedAt: number
  endedAt?: number
  isEventStream?: boolean
  bodyTruncated?: boolean
  error?: string
}

export type RpaFindingKind = 'chat' | 'models' | 'session' | 'share' | 'pow/challenge' | 'unknown'

export interface RpaEndpointFinding {
  kind: RpaFindingKind
  method: string
  url: string
  path: string
  status?: number
  confidence: number
  reasons: string[]
  authHeaders: string[]
  authQueryParams?: string[]
  isStreaming: boolean
  requestShape?: string[]
  responseShape?: string[]
  models?: string[]
}

export interface RpaCredentialReference {
  providerId?: string
  accountId?: string
  credentialKeys: string[]
}

export interface RpaLearningResult {
  sessionId: string
  target: RpaTarget
  learningTarget?: RpaProviderLearningTarget
  origin: string
  capturedAt: number
  requests: RpaCapturedRequest[]
  findings: RpaEndpointFinding[]
  primaryChat?: RpaEndpointFinding
  warnings: string[]
  credentialsReference?: RpaCredentialReference
  automationSteps?: RpaAutomationStepResult[]
}

export interface RpaPatchFile {
  path: string
  action: 'create' | 'update'
  content: string
}

export interface RpaPatchPreview {
  sessionId: string
  canApply: boolean
  confidence: number
  summary: string
  files: RpaPatchFile[]
  warnings: string[]
}

export interface RpaAnalysisReport {
  sessionId: string
  generatedAt: number
  markdown: string
}

export interface RpaLearningSessionSummary {
  id: string
  status: RpaSessionStatus
  startedAt: number
  target?: RpaTarget
  capturedCount: number
  result?: RpaLearningResult
  patch?: RpaPatchPreview
  report?: RpaAnalysisReport
  warnings: string[]
}
