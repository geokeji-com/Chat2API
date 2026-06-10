export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export type DeepSeekModelType = 'default' | 'expert' | null

export interface DeepSeekCompletionPayload {
  chat_session_id: string
  parent_message_id: string | number | null
  model_type: DeepSeekModelType
  prompt: string
  ref_file_ids: string[]
  thinking_enabled: boolean
  search_enabled: boolean
  action: null
  preempt: false
}

export function normalizeDeepSeekFollowUpPrompt(prompt: string): string {
  return String(prompt || '')
    .trim()
    .replace(/^<[\|｜]User[\|｜]>\s*/i, '')
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')
  const requestedSearch = Boolean(request.web_search) || isSearchAlias

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: isProModel ? false : requestedSearch,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export function buildDeepSeekCompletionPayload(options: {
  sessionId: string
  parentMessageId: string | number | null
  prompt: string
  modelType: DeepSeekModelType
  searchEnabled: boolean
  thinkingEnabled: boolean
}): DeepSeekCompletionPayload {
  return {
    chat_session_id: options.sessionId,
    parent_message_id: options.parentMessageId,
    model_type: options.parentMessageId === null ? options.modelType : null,
    prompt: options.prompt,
    ref_file_ids: [],
    thinking_enabled: options.thinkingEnabled,
    search_enabled: options.searchEnabled,
    action: null,
    preempt: false,
  }
}

export type KimiScenario = 'SCENARIO_K2D5'

export function resolveKimiScenario(_model: string): KimiScenario {
  return 'SCENARIO_K2D5'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
}) {
  const scenario = resolveKimiScenario(options.model)

  return {
    scenario,
    tools: options.enableWebSearch
      ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }]
      : [],
    message: {
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}

export interface QwenChatOptionInput {
  model: string
  originalModel?: string
  web_search?: boolean
  reasoning_effort?: string
  enableThinking?: boolean
  enableWebSearch?: boolean
}

export interface QwenChatOptions {
  actualModel: string
  searchEnabled: boolean
  thinkingEnabled: boolean
  deepSearch: '0' | '1'
}

export const QWEN_MODEL_MAP: Record<string, string> = {
  'Qwen3.7-千问': 'Qwen',
  'Qwen3.7-Max': 'Qwen3.7-Max',
  'Qwen3.5-Flash': 'Qwen3.5-Flash',
  'Qwen3-Max': 'Qwen3-Max',
  'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
  'Qwen3-Coder': 'Qwen3-Coder',
}

export function mapQwenModel(model: string): string {
  return QWEN_MODEL_MAP[model] || model
}

export function resolveQwenChatOptions(request: QwenChatOptionInput): QwenChatOptions {
  const modelForDetection = request.originalModel || request.model
  const modelLower = modelForDetection.toLowerCase()

  let thinkingEnabled = Boolean(request.enableThinking) || Boolean(request.reasoning_effort)
  let searchEnabled = Boolean(request.enableWebSearch) || Boolean(request.web_search)

  if (!thinkingEnabled && (modelLower.includes('think') || modelLower.includes('r1'))) {
    thinkingEnabled = true
  }
  if (!searchEnabled && modelLower.includes('search')) {
    searchEnabled = true
  }

  return {
    actualModel: mapQwenModel(request.model),
    searchEnabled,
    thinkingEnabled,
    deepSearch: thinkingEnabled ? '1' : '0',
  }
}
