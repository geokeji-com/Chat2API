import type { ChatCompletionResponse } from '../proxy/types.ts'
import type {
  GatewayChatTask,
  GatewayTaskFailure,
  GatewayTaskResult,
  WorkerAccountContext,
} from '../../shared/gatewayWorker.ts'

export interface WorkerChatExecutionOutput {
  response: ChatCompletionResponse & Record<string, unknown>
  providerMetadata?: Record<string, unknown>
}

export interface BuildTaskResultInput {
  task: GatewayChatTask
  workerId: string
  accountContext: WorkerAccountContext
  output: WorkerChatExecutionOutput
  startedAt: Date
  completedAt: Date
}

export interface BuildTaskFailureInput {
  task: GatewayChatTask
  workerId: string
  accountContext?: WorkerAccountContext
  error: unknown
  startedAt: Date
  failedAt: Date
  code?: string
  retryable?: boolean
  details?: Record<string, unknown>
}

export function buildTaskResult(input: BuildTaskResultInput): GatewayTaskResult {
  const message = input.output.response.choices?.[0]?.message
  const responseAny = input.output.response as Record<string, any>
  const chat2api = responseAny.chat2api && typeof responseAny.chat2api === 'object'
    ? responseAny.chat2api as Record<string, unknown>
    : undefined

  return {
    task_id: input.task.task_id,
    attempt_id: resolveAttemptId(input.task),
    worker_id: input.workerId,
    status: 'completed',
    platform: input.task.platform,
    ...(input.task.target ? { target: input.task.target } : {}),
    account_context: input.accountContext,
    result: {
      content: message?.content || '',
      reasoning_content: message?.reasoning_content || '',
      search_queries: normalizeTextList(message?.search_queries || responseAny.search_queries),
      citations: normalizeCitations(message?.citations || responseAny.citations),
      related_searches: normalizeRelatedSearches(message?.related_searches || responseAny.related_searches),
      ...(resolveShareUrl(input.output.response) ? { share_url: resolveShareUrl(input.output.response) } : {}),
    },
    provider_metadata: {
      ...(chat2api || {}),
      ...(input.output.providerMetadata || {}),
    },
    ...(input.output.response.usage ? { usage: input.output.response.usage } : {}),
    timing: {
      started_at: input.startedAt.toISOString(),
      completed_at: input.completedAt.toISOString(),
      duration_ms: input.completedAt.getTime() - input.startedAt.getTime(),
    },
  }
}

export function buildTaskFailure(input: BuildTaskFailureInput): GatewayTaskFailure {
  return {
    task_id: input.task.task_id,
    attempt_id: resolveAttemptId(input.task),
    worker_id: input.workerId,
    status: 'failed',
    platform: input.task.platform,
    ...(input.accountContext ? { account_context: input.accountContext } : {}),
    error: {
      code: input.code || inferErrorCode(input.error),
      message: input.error instanceof Error ? input.error.message : String(input.error),
      retryable: input.retryable ?? true,
      ...(input.details ? { details: input.details } : {}),
    },
    timing: {
      started_at: input.startedAt.toISOString(),
      failed_at: input.failedAt.toISOString(),
      duration_ms: input.failedAt.getTime() - input.startedAt.getTime(),
    },
  }
}

export function resolveAttemptId(task: GatewayChatTask): string {
  return task.lease?.attempt_id || `attempt_${task.task_id}`
}

function resolveShareUrl(response: ChatCompletionResponse & Record<string, unknown>): string | undefined {
  const chat2api = response.chat2api as Record<string, unknown> | undefined
  const shareUrl = chat2api?.share_url
  return typeof shareUrl === 'string' && shareUrl ? shareUrl : undefined
}

function normalizeCitations(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : []
}

function normalizeTextList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  const normalized: string[] = []

  for (const item of values) {
    const text = extractTextValue(item)
    if (text && !normalized.includes(text)) {
      normalized.push(text)
    }
  }

  return normalized
}

function normalizeRelatedSearches(value: unknown): string[] | '' {
  const items = normalizeTextList(value)
  return items.length > 0 ? items : ''
}

function extractTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text || undefined
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of ['query', 'question', 'text', 'content', 'title']) {
    const text = typeof record[key] === 'string' ? record[key].trim() : ''
    if (text) {
      return text
    }
  }

  return undefined
}

function inferErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout/i.test(message)) return 'PROVIDER_TIMEOUT'
  if (/no available account/i.test(message)) return 'NO_AVAILABLE_ACCOUNT'
  if (/unauthorized|forbidden|token|credential/i.test(message)) return 'AUTH_FAILED'
  return 'WORKER_EXECUTION_FAILED'
}
