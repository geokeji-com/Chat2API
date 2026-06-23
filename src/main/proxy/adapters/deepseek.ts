/**
 * DeepSeek Adapter
 * Implements DeepSeek web API protocol
 * 
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import {
  buildDeepSeekCompletionPayload,
  normalizeDeepSeekFollowUpPrompt,
  resolveDeepSeekChatOptions,
  type DeepSeekModelType,
} from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { applyAxiosProxyConfig, type OutboundProxyContext } from '../proxyTransport'
import { appendDebugTraceEvent, sanitizeDebugTraceValue } from '../debugTrace'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: DeepSeekMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  tools?: any[]
  tool_choice?: any
  chat2api_debug_raw?: boolean
  chat2api_debug_log_file?: string
}

export type DeepSeekMessageId = string | number

export interface DeepSeekShareInfo {
  provider: 'deepseek'
  session_id: string
  message_id?: DeepSeekMessageId
  message_ids?: DeepSeekMessageId[]
  conversation_url: string
  share_url?: string
  share_id?: string
  share_error?: string
}

const tokenCache = new Map<string, TokenInfo>()

function toPositiveIntegerMessageId(messageId: DeepSeekMessageId | undefined): number | undefined {
  if (typeof messageId === 'number') {
    return Number.isInteger(messageId) && messageId > 0 ? messageId : undefined
  }

  if (typeof messageId === 'string' && /^\d+$/.test(messageId)) {
    const parsed = Number(messageId)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }

  return undefined
}

export function buildDeepSeekShareMessageIds(
  fetchedMessageIds: DeepSeekMessageId[],
  fallbackMessageId?: DeepSeekMessageId
): DeepSeekMessageId[] {
  const uniqueMessageIds = [...fetchedMessageIds, fallbackMessageId]
    .filter((messageId): messageId is DeepSeekMessageId =>
      (typeof messageId === 'string' && messageId.length > 0)
      || (typeof messageId === 'number' && Number.isFinite(messageId))
    )
    .filter((messageId, index, allMessageIds) => allMessageIds.indexOf(messageId) === index)

  if (uniqueMessageIds.length >= 2) {
    return uniqueMessageIds
  }

  const numericMessageId = toPositiveIntegerMessageId(uniqueMessageIds[0])
  if (numericMessageId && numericMessageId > 1) {
    return [numericMessageId - 1, numericMessageId]
  }

  return uniqueMessageIds
}

function normalizeDeepSeekMessageIds(messageIds: DeepSeekMessageId[] | undefined): DeepSeekMessageId[] {
  if (!Array.isArray(messageIds)) {
    return []
  }

  return messageIds
    .filter((messageId): messageId is DeepSeekMessageId =>
      (typeof messageId === 'string' && messageId.length > 0)
      || (typeof messageId === 'number' && Number.isFinite(messageId))
    )
    .filter((messageId, index, allMessageIds) => allMessageIds.indexOf(messageId) === index)
}

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  }
  const chars = sets[charset as keyof typeof sets] || sets.alphanumeric
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function generateCookie(): string {
  const timestamp = Date.now()
  return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${generateRandomString(18, 'hex')}; Hm_lvt_${uuid(false)}=${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)}; Hm_lpvt_${uuid(false)}=${Math.floor(timestamp / 1000)}; _frid=${uuid(false)}; _fr_ssid=${uuid(false)}; _fr_pvid=${uuid(false)}`
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account
  private token: string
  private outboundProxy?: OutboundProxyContext
  private debugRaw: boolean
  private debugLogFile?: string

  constructor(
    provider: Provider,
    account: Account,
    outboundProxy?: OutboundProxyContext,
    debugOptions?: { raw?: boolean; logFile?: string },
  ) {
    this.provider = provider
    this.account = account
    this.outboundProxy = outboundProxy
    this.debugRaw = debugOptions?.raw === true
    this.debugLogFile = debugOptions?.logFile
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
  }

  setDebugOptions(options: { raw?: boolean; logFile?: string }): void {
    this.debugRaw = options.raw === true
    this.debugLogFile = options.logFile
  }

  getDebugRawEnabled(): boolean {
    return this.debugRaw
  }

  getDebugLogFile(): string | undefined {
    return this.debugLogFile
  }

  private trace(event: string, data: Record<string, any>): void {
    if (!this.debugRaw) {
      return
    }

    appendDebugTraceEvent(this.debugLogFile, event, {
      provider: 'deepseek',
      providerId: this.provider.id,
      accountId: this.account.id,
      proxy: this.outboundProxy
        ? {
            id: this.outboundProxy.node.id,
            name: this.outboundProxy.node.name,
            host: this.outboundProxy.node.host,
            port: this.outboundProxy.node.port,
          }
        : null,
      ...data,
    })
  }

  private async tracedAxios<T = any>(event: string, config: any): Promise<AxiosResponse<T>> {
    const startedAt = Date.now()
    this.trace(`${event}.request`, {
      method: config.method || 'GET',
      url: config.url,
      headers: config.headers,
      data: config.data,
      responseType: config.responseType,
      timeout: config.timeout,
    })

    try {
      const response = await axios.request<T>(config)
      this.trace(`${event}.response`, {
        method: config.method || 'GET',
        url: config.url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: sanitizeDebugTraceValue(response.data),
        latencyMs: Date.now() - startedAt,
      })
      return response
    } catch (error: any) {
      this.trace(`${event}.error`, {
        method: config.method || 'GET',
        url: config.url,
        message: error?.message || String(error),
        code: error?.code,
        status: error?.response?.status,
        responseHeaders: error?.response?.headers,
        responseData: sanitizeDebugTraceValue(error?.response?.data),
        latencyMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  private async acquireToken(): Promise<string> {
    if (!this.token) {
      throw new Error('DeepSeek Token not configured, please add Token in account settings')
    }

    const cached = tokenCache.get(this.token)
    if (cached && cached.expiresAt > unixTimestamp()) {
      return cached.accessToken
    }

    console.log('[DeepSeek] Acquiring token...')
    
    const result = await this.tracedAxios('deepseek.users.current', applyAxiosProxyConfig({
      method: 'GET',
      url: `${DEEPSEEK_API_BASE}/v0/users/current`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }, this.outboundProxy))

    console.log('[DeepSeek] Token response status:', result.status)
    
    if (result.status === 401 || result.status === 403) {
      throw new Error(`Token invalid or expired, please get a new Token`)
    }

    if (result.status !== 200) {
      throw new Error(`Failed to acquire token: HTTP ${result.status}`)
    }

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { token: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (!bizData?.token) {
      const errorMsg = result.data?.msg || result.data?.data?.biz_msg || 'Unknown error'
      console.log('[DeepSeek] Token response data:', JSON.stringify(result.data, null, 2))
      throw new Error(`Failed to acquire token: ${errorMsg}`)
    }

    const accessToken = bizData.token
    tokenCache.set(this.token, {
      accessToken,
      refreshToken: this.token,
      expiresAt: unixTimestamp() + 3600,
    })

    console.log('[DeepSeek] Token acquired successfully')
    return accessToken
  }

  private async createSession(): Promise<string> {
    const token = await this.acquireToken()
    const result = await this.tracedAxios('deepseek.chat_session.create', applyAxiosProxyConfig({
        method: 'POST',
        url: `${DEEPSEEK_API_BASE}/v0/chat_session/create`,
        data: {},
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15000,
        validateStatus: () => true,
      }, this.outboundProxy)
    )

    console.log('[DeepSeek] Create session response:', JSON.stringify(result.data, null, 2))

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { id: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.chat_session?.id) {
      throw new Error(`Failed to create session: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    const sessionId = bizData?.chat_session?.id
    return sessionId
  }

  getConversationUrl(sessionId: string): string {
    return `https://chat.deepseek.com/a/chat/s/${sessionId}`
  }

  async fetchSessionMessageIds(sessionId: string, token?: string): Promise<DeepSeekMessageId[]> {
    const effectiveToken = token || await this.acquireToken()
    const result = await this.tracedAxios('deepseek.chat.history_messages', applyAxiosProxyConfig({
        method: 'GET',
        url: `${DEEPSEEK_API_BASE}/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
        headers: {
          Authorization: `Bearer ${effectiveToken}`,
          ...FAKE_HEADERS,
          Referer: this.getConversationUrl(sessionId),
        },
        timeout: 15000,
        validateStatus: () => true,
      }, this.outboundProxy)
    )

    if (result.status !== 200) {
      throw new Error(result.data?.msg || result.data?.data?.biz_msg || `HTTP ${result.status}`)
    }

    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    const messages = bizData?.chat_messages
    if (!Array.isArray(messages)) {
      return []
    }

    return messages
      .map((message: any) => message?.message_id || message?.id)
      .filter((messageId: unknown): messageId is DeepSeekMessageId =>
        (typeof messageId === 'string' && messageId.length > 0)
        || (typeof messageId === 'number' && Number.isFinite(messageId))
      )
  }

  async createShareLink(
    sessionId: string,
    messageId?: DeepSeekMessageId,
    preferredMessageIds?: DeepSeekMessageId[],
  ): Promise<DeepSeekShareInfo> {
    const conversationUrl = this.getConversationUrl(sessionId)

    try {
      const token = await this.acquireToken()
      const readyMessageIds = normalizeDeepSeekMessageIds(preferredMessageIds)
      let fetchedMessageIds: DeepSeekMessageId[] = []

      if (readyMessageIds.length < 2) {
        try {
          fetchedMessageIds = await this.fetchSessionMessageIds(sessionId, token)
        } catch (error) {
          console.warn('[DeepSeek] Failed to fetch session message IDs:', error)
        }
      }

      const messageIds = readyMessageIds.length >= 2
        ? readyMessageIds
        : buildDeepSeekShareMessageIds(fetchedMessageIds, messageId)
      if (messageIds.length === 0) {
        return {
          provider: 'deepseek',
          session_id: sessionId,
          conversation_url: conversationUrl,
          share_error: 'DeepSeek message IDs were not found',
        }
      }

      const result = await this.tracedAxios('deepseek.share.create', applyAxiosProxyConfig({
        method: 'POST',
        url: `${DEEPSEEK_API_BASE}/v0/share/create`,
        data: {
          chat_session_id: sessionId,
          message_ids: messageIds,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Referer: conversationUrl,
          Cookie: generateCookie(),
        },
        timeout: 15000,
        validateStatus: () => true,
      }, this.outboundProxy))

      console.log('[DeepSeek] Create share response:', JSON.stringify(result.data, null, 2))

      const bizData = result.data?.data?.biz_data || result.data?.biz_data
      const shareId = bizData?.share_id
      if (result.status !== 200 || !shareId) {
        return {
          provider: 'deepseek',
          session_id: sessionId,
          message_id: messageId,
          message_ids: messageIds,
          conversation_url: conversationUrl,
          share_error: result.data?.msg || result.data?.data?.biz_msg || `HTTP ${result.status}`,
        }
      }

      return {
        provider: 'deepseek',
        session_id: sessionId,
        message_id: messageId,
        message_ids: messageIds,
        conversation_url: conversationUrl,
        share_id: shareId,
        share_url: `https://chat.deepseek.com/share/${shareId}`,
      }
    } catch (error) {
      return {
        provider: 'deepseek',
        session_id: sessionId,
        message_id: messageId,
        conversation_url: conversationUrl,
        share_error: error instanceof Error ? error.message : 'Failed to create DeepSeek share link',
      }
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await this.tracedAxios('deepseek.chat_session.delete', applyAxiosProxyConfig({
          method: 'POST',
          url: `${DEEPSEEK_API_BASE}/v0/chat_session/delete`,
          data: { chat_session_id: sessionId },
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }, this.outboundProxy)
      )

      console.log('[DeepSeek] Delete session response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        console.log('[DeepSeek] Session deleted:', sessionId)
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete session:', error)
      return false
    }
  }

  private async getChallenge(targetPath: string): Promise<ChallengeResponse> {
    const token = await this.acquireToken()
    const result = await this.tracedAxios('deepseek.chat.create_pow_challenge', applyAxiosProxyConfig({
        method: 'POST',
        url: `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
        data: { target_path: targetPath },
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }, this.outboundProxy)
    )

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { challenge: {...} } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.challenge) {
      throw new Error(`Failed to get challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    return bizData.challenge
  }

  private async calculateChallengeAnswer(challenge: ChallengeResponse): Promise<string> {
    const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge
    
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`)
    }
    
    console.log('[DeepSeek] Challenge parameters:', { difficulty })
    
    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
    
    if (answer === undefined) {
      throw new Error('Challenge calculation failed')
    }
    
    console.log('[DeepSeek] Challenge answer found:', answer)

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: '/api/v0/chat/completion',
    })).toString('base64')
  }

  private messagesToPrompt(messages: DeepSeekMessage[], isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('deepseek')
    const processedMessages = messages.map(message => {
      let text: string

      // Handle tool calls in assistant message
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        text = toolProfile.formatAssistantToolCalls(message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
      }
      // Handle tool response message
      else if (message.role === 'tool' && message.tool_call_id) {
        text = toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: String(message.content || ''),
        })
      }
      else if (Array.isArray(message.content)) {
        const texts = message.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
        text = texts.join('\n')
      } else {
        text = String(message.content || '')
      }
      return { role: message.role, text }
    })

    if (processedMessages.length === 0) return ''

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let text = lastUserMsg.text
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'tool') {
            text += `\n\n${processedMessages[i].text}`
          }
        }
        return `<｜User｜>${text}`
      }
    }

    const mergedBlocks: { role: string; text: string }[] = []
    let currentBlock = { ...processedMessages[0] }

    for (let i = 1; i < processedMessages.length; i++) {
      const msg = processedMessages[i]
      if (msg.role === currentBlock.role) {
        currentBlock.text += `\n\n${msg.text}`
      } else {
        mergedBlocks.push(currentBlock)
        currentBlock = { ...msg }
      }
    }
    mergedBlocks.push(currentBlock)

    return mergedBlocks
      .map((block, index) => {
        if (block.role === 'assistant') {
          return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
        }
        if (block.role === 'user' || block.role === 'system') {
          return index > 0 ? `<｜User｜>${block.text}` : block.text
        }
        if (block.role === 'tool') {
          return `<｜User｜>${block.text}`
        }
        return block.text
      })
      .join('')
      .replace(/!\[.+\]\(.+\)/g, '')
  }

  private async sendCompletion(options: {
    token: string
    sessionId: string
    parentMessageId: DeepSeekMessageId | null
    prompt: string
    modelType: DeepSeekModelType
    searchEnabled: boolean
    thinkingEnabled: boolean
  }): Promise<AxiosResponse> {
    const challenge = await this.getChallenge('/api/v0/chat/completion')
    const challengeAnswer = await this.calculateChallengeAnswer(challenge)
    const payload = buildDeepSeekCompletionPayload(options)

    return this.tracedAxios('deepseek.chat.completion', applyAxiosProxyConfig({
        method: 'POST',
        url: `${DEEPSEEK_API_BASE}/v0/chat/completion`,
        data: payload,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...FAKE_HEADERS,
          Referer: this.getConversationUrl(options.sessionId),
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challengeAnswer,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }, this.outboundProxy)
    )
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    if (request.chat2api_debug_raw !== undefined || request.chat2api_debug_log_file !== undefined) {
      this.setDebugOptions({
        raw: request.chat2api_debug_raw === true,
        logFile: request.chat2api_debug_log_file,
      })
    }

    const token = await this.acquireToken()
    
    const sessionId = await this.createSession()
    console.log('[DeepSeek] Created new session:', sessionId)

    // Clone messages to avoid modifying original request
    // Note: Tool prompt injection is already handled by Forwarder.transformRequestForPromptToolUse()
    const messages = [...request.messages]

    let prompt = this.messagesToPrompt(messages, false)

    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request, prompt)

    if (request.web_search || request.model.toLowerCase().includes('search')) {
      if (modelType === 'expert' && !searchEnabled) {
        console.log('[DeepSeek] Expert mode does not support web search; search_enabled is forced to false')
      } else {
        console.log('[DeepSeek] Web search enabled')
      }
    }

    if (request.reasoning_effort || thinkingEnabled) {
      console.log('[DeepSeek] Reasoning mode enabled, effort:', request.reasoning_effort)
    }

    const response = await this.sendCompletion({
      token,
      sessionId,
      parentMessageId: null,
      prompt,
      modelType,
      searchEnabled,
      thinkingEnabled,
    })

    return { response, sessionId }
  }

  async sendFollowUp(sessionId: string, parentMessageId: DeepSeekMessageId, prompt: string, model: string): Promise<AxiosResponse> {
    const token = await this.acquireToken()
    const { searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions({ model }, prompt)

    return this.sendCompletion({
      token,
      sessionId,
      parentMessageId,
      prompt: normalizeDeepSeekFollowUpPrompt(prompt),
      modelType: null,
      searchEnabled,
      thinkingEnabled,
    })
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await this.tracedAxios('deepseek.chat_session.delete_all', applyAxiosProxyConfig({
          method: 'POST',
          url: `${DEEPSEEK_API_BASE}/v0/chat_session/delete_all`,
          data: {},
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 30000,
          validateStatus: () => true,
        }, this.outboundProxy)
      )

      console.log('[DeepSeek] Delete all chats response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        console.log('[DeepSeek] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete all chats:', error)
      return false
    }
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    return provider.id === 'deepseek' || provider.apiEndpoint.includes('deepseek.com')
  }

  static clearSessionCache(_accountId: string): void {}
}

export const deepSeekAdapter = {
  DeepSeekAdapter,
}
