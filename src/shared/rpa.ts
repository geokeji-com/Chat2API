export type RpaBrowser = 'chrome' | 'edge'

export type RpaProfileMode = 'dedicated' | 'existing-debug'

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
  providerId?: string
  accountId?: string
  prompt?: string
  timeoutMs?: number
}

export interface RpaProgressEvent {
  status: RpaSessionStatus
  message: string
  sessionId?: string
  data?: Record<string, unknown>
}

export interface RpaCapturedRequest {
  id: string
  url: string
  method: string
  resourceType: string
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

export type RpaFindingKind = 'chat' | 'models' | 'session' | 'unknown'

export interface RpaEndpointFinding {
  kind: RpaFindingKind
  method: string
  url: string
  path: string
  status?: number
  confidence: number
  reasons: string[]
  authHeaders: string[]
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
  origin: string
  capturedAt: number
  requests: RpaCapturedRequest[]
  findings: RpaEndpointFinding[]
  primaryChat?: RpaEndpointFinding
  warnings: string[]
  credentialsReference?: RpaCredentialReference
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

export interface RpaLearningSessionSummary {
  id: string
  status: RpaSessionStatus
  startedAt: number
  target?: RpaTarget
  capturedCount: number
  result?: RpaLearningResult
  patch?: RpaPatchPreview
  warnings: string[]
}
