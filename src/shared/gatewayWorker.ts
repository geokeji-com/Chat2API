export type GatewayTaskType = 'chat_completion'

export type GatewayTaskStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WorkerCityMatchPolicy = 'required' | 'preferred' | 'any'

export interface WorkerGeoLocation {
  country?: string
  province?: string
  city?: string
  region_code?: string
}

export interface GatewayTaskPlatform {
  provider_id: string
  model: string
  model_alias?: string
}

export interface GatewayTaskAccountScope extends WorkerGeoLocation {
  account_id?: string
  tags?: string[]
  match_policy?: WorkerCityMatchPolicy
}

export interface GatewayTaskMode {
  stream?: boolean
  web_search?: boolean
  thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  share?: boolean
  include_final_response?: boolean
}

export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
}

export interface GatewayChatTaskInput {
  messages: GatewayChatMessage[]
}

export interface GatewayTaskOutputSpec {
  format: 'structured_answer'
  required_fields?: Array<'content' | 'reasoning_content' | 'citations' | 'share_url'>
  schema?: Record<string, unknown>
}

export interface GatewayTaskLeaseSpec {
  attempt_id?: string
  lease_timeout_ms?: number
  leased_until?: string
}

export interface GatewayChatTask {
  task_id: string
  type: GatewayTaskType
  priority?: number
  platform: GatewayTaskPlatform
  target?: WorkerGeoLocation
  account_scope?: GatewayTaskAccountScope
  mode?: GatewayTaskMode
  input: GatewayChatTaskInput
  output?: GatewayTaskOutputSpec
  lease?: GatewayTaskLeaseSpec
  metadata?: Record<string, unknown>
  created_at?: string
}

export interface WorkerCapabilityFeatureSet {
  stream: boolean
  web_search: boolean
  thinking: boolean
  share_url: boolean
  citations: boolean
}

export interface WorkerCapability {
  provider_id: string
  models: string[]
  account_locations: WorkerGeoLocation[]
  features: WorkerCapabilityFeatureSet
  max_concurrency: number
}

export interface WorkerRegistration {
  worker_id: string
  name: string
  version: string
  capabilities: WorkerCapability[]
  limits: {
    max_cached_tasks: number
    max_task_timeout_ms: number
  }
  metadata?: Record<string, unknown>
}

export interface GatewayRegistrationAck {
  accepted: boolean
  worker_id: string
  server_time: string
  heartbeat_interval_ms: number
  message?: string
}

export interface GatewayHeartbeat {
  worker_id: string
  active_tasks: number
  cached_tasks: number
  timestamp: string
}

export interface GatewayTaskLeaseRequest {
  worker_id: string
  max_tasks: number
  capabilities?: WorkerCapability[]
}

export interface GatewayTaskLeaseBatch {
  tasks: GatewayChatTask[]
  server_time: string
}

export interface WorkerAccountContext extends WorkerGeoLocation {
  provider_id: string
  account_id: string
  account_name: string
  proxy_id?: string
  proxy_name?: string
  location_source: 'account_feature' | 'proxy_binding' | 'unknown'
}

export interface GatewayTaskResult {
  task_id: string
  attempt_id: string
  worker_id: string
  status: 'completed'
  platform: GatewayTaskPlatform
  target?: WorkerGeoLocation
  account_context: WorkerAccountContext
  result: {
    content: string
    reasoning_content: string
    search_queries: string[]
    citations: Array<Record<string, unknown>>
    related_searches: string[] | ''
    share_url?: string
  }
  provider_metadata?: Record<string, unknown>
  usage?: Record<string, number>
  timing: {
    started_at: string
    completed_at: string
    duration_ms: number
  }
}

export interface GatewayTaskFailure {
  task_id: string
  attempt_id: string
  worker_id: string
  status: 'failed'
  platform?: GatewayTaskPlatform
  account_context?: WorkerAccountContext
  error: {
    code: string
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
  timing: {
    started_at: string
    failed_at: string
    duration_ms: number
  }
}
