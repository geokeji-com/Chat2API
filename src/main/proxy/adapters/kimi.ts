/**
 * Kimi K2.6 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'
import { PassThrough } from 'stream'
import { createHash, randomBytes } from 'crypto'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { createKimiChatPayload, encodeKimiGrpcFrame } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import { applyAxiosProxyConfig, type OutboundProxyContext } from '../proxyTransport'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  Referer: `${KIMI_API_BASE}/`,
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
  'X-Msh-Platform': 'web',
  'X-Msh-Version': '1.0.0',
  'X-Language': 'zh-CN',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  userId: string
  refreshTime: number
}

interface KimiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  enableWebSearch?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
}

const accessTokenMap = new Map<string, TokenInfo>()

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function parseJwtPayload(token: string): Record<string, any> | undefined {
  try {
    const [, payload] = token.split('.')
    if (!payload) return undefined
    return JSON.parse(decodeBase64Url(payload))
  } catch {
    return undefined
  }
}

function pickCredential(credentials: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = credentials[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function deriveStableNumericId(seed: string, prefix: string): string {
  const hash = createHash('sha256').update(`${prefix}:${seed}`).digest('hex')
  const decimal = BigInt(`0x${hash.slice(0, 15)}`).toString()
  return `${prefix}${decimal}`.slice(0, 19)
}

function normalizeCookieHeader(rawCookie: string | undefined, authToken: string): string | undefined {
  const cookie = rawCookie?.trim()
  if (!cookie && authToken) {
    return `kimi-auth=${authToken}`
  }
  if (!cookie) {
    return undefined
  }

  if (/(^|;\s*)kimi-auth=/.test(cookie) || !authToken) {
    return cookie
  }

  return `${cookie}; kimi-auth=${authToken}`
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function createTrafficId(): string {
  return randomBytes(10).toString('hex')
}

export function detectTokenType(token: string): 'jwt' | 'refresh' {
  if (token.startsWith('eyJ') && token.split('.').length === 3) {
    const payload = parseJwtPayload(token)
    if (payload?.app_id === 'kimi' && payload?.typ === 'access') {
      return 'jwt'
    }
  }
  return 'refresh'
}

function extractUserIdFromJWT(token: string): string | undefined {
  return parseJwtPayload(token)?.sub
}

function checkResult(result: AxiosResponse, refreshToken: string): any {
  if (result.status === 401) {
    accessTokenMap.delete(refreshToken)
    throw new Error('Token invalid or expired')
  }
  if (!result.data) {
    return null
  }
  const { error_type, message } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  if (error_type === 'auth.token.invalid') {
    accessTokenMap.delete(refreshToken)
  }
  throw new Error(`Kimi API error: ${message || error_type}`)
}

export class KimiAdapter {
  private provider: Provider
  private account: Account
  private token: string
  private outboundProxy?: OutboundProxyContext

  constructor(provider: Provider, account: Account, outboundProxy?: OutboundProxyContext) {
    this.provider = provider
    this.account = account
    this.outboundProxy = outboundProxy
    this.token = pickCredential(
      account.credentials,
      'token',
      'accessToken',
      'access_token',
      'apiKey',
      'api_key',
      'refreshToken',
      'refresh_token'
    ) || ''
  }

  private getJwtValue(accessToken: string, ...keys: string[]): string | undefined {
    const payload = parseJwtPayload(accessToken)
    if (!payload) return undefined

    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return undefined
  }

  private getDeviceId(accessToken: string): string {
    return pickCredential(this.account.credentials, 'deviceId', 'device_id', 'xMshDeviceId', 'x_msh_device_id')
      || this.getJwtValue(accessToken, 'device_id', 'deviceId', 'did')
      || deriveStableNumericId(accessToken || this.account.id, '7')
  }

  private getSessionId(accessToken: string): string {
    return pickCredential(this.account.credentials, 'sessionId', 'session_id', 'ssid', 'xMshSessionId', 'x_msh_session_id')
      || this.getJwtValue(accessToken, 'ssid', 'session_id', 'sessionId', 'sid')
      || deriveStableNumericId(accessToken || this.account.id, '1')
  }

  private getCookieHeader(accessToken: string): string | undefined {
    return normalizeCookieHeader(
      pickCredential(this.account.credentials, 'cookies', 'cookie', 'cookieStr', 'cookie_str'),
      accessToken || this.token
    )
  }

  private buildWebHeaders(accessToken: string, contentType: string): Record<string, string> {
    const cookie = this.getCookieHeader(accessToken)
    return {
      ...FAKE_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      'Connect-Protocol-Version': '1',
      'X-Msh-Device-Id': this.getDeviceId(accessToken),
      'X-Msh-Session-Id': this.getSessionId(accessToken),
      'X-Traffic-Id': createTrafficId(),
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  getConversationUrl(chatId: string): string {
    return `${KIMI_API_BASE}/chat/${encodeURIComponent(chatId)}`
  }

  private async acquireToken(): Promise<{ accessToken: string; userId: string }> {
    if (!this.token) {
      throw new Error('Kimi Token not configured')
    }

    let result = accessTokenMap.get(this.token)
    if (result && result.refreshTime > unixTimestamp()) {
      console.log('[Kimi] Using cached token')
      return { accessToken: result.accessToken, userId: result.userId }
    }

    const tokenType = detectTokenType(this.token)
    console.log('[Kimi] Token type:', tokenType)

    if (tokenType === 'jwt') {
      const userId = extractUserIdFromJWT(this.token) || ''
      accessTokenMap.set(this.token, {
        accessToken: this.token,
        refreshToken: this.token,
        userId,
        refreshTime: unixTimestamp() + 300,
      })
      console.log('[Kimi] Using JWT token, userId:', userId)
      return { accessToken: this.token, userId }
    }

    console.log('[Kimi] Non-JWT token detected, attempting direct use...')
    accessTokenMap.set(this.token, {
      accessToken: this.token,
      refreshToken: this.token,
      userId: '',
      refreshTime: unixTimestamp() + 300,
    })
    return { accessToken: this.token, userId: '' }
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('kimi')
    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          ...msg,
          content: toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }))),
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: String(msg.content || ''),
          }),
        }
      }
      return msg
    })

    // Extract system message first
    let systemContent = ''
    const otherMessages = processedMessages.filter(msg => {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : ''
        systemContent = text
        return false
      }
      return true
    })

    let content = ''

    // Prepend system message if exists
    if (systemContent) {
      content = `system:${systemContent}\n`
    }

    // For multi-turn with existing session, only send the last user message
    if (isMultiTurn) {
      // Find last user message index manually (ES2021 compatible)
      let lastUserIdx = -1
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        if (otherMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = otherMessages[lastUserIdx]
        const text = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''
        content += `user:${this.wrapUrlsToTags(text)}\n`
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < otherMessages.length; i++) {
          if (otherMessages[i].role === 'user') {
            const toolText = typeof otherMessages[i].content === 'string' ? otherMessages[i].content : ''
            content += `user:${toolText}\n`
          }
        }
        
        if (toolsPrompt) {
          content = content.trim() + "\n\n" + toolsPrompt
        }
        return content
      }
    }

    if (otherMessages.length < 2) {
      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    } else {
      const latestMessage = otherMessages[otherMessages.length - 1]
      const hasFileOrImage = Array.isArray(latestMessage.content) &&
        latestMessage.content.some((v: any) => typeof v === 'object' && ['file', 'image_url'].includes(v.type))

      if (hasFileOrImage) {
        otherMessages.splice(otherMessages.length - 1, 0, {
          content: 'Focus on the latest files and messages sent by user',
          role: 'system' as const,
        })
      } else {
        otherMessages.splice(otherMessages.length - 1, 0, {
          content: 'Focus on the latest message from user',
          role: 'system' as const,
        })
      }

      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    }

    // Inject tools prompt at the VERY END of the content to maximize attention
    if (toolsPrompt) {
      content = content.trim() + "\n\n" + toolsPrompt
    }

    return content
  }

  private wrapUrlsToTags(content: string): string {
    return content.replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
      url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
    )
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    const { accessToken } = await this.acquireToken()

    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      toolsPrompt = toolsToSystemPrompt(request.tools, true)

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    const content = this.messagesPrepare(messages, toolsPrompt, false)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    let enableThinking = request.enableThinking ?? false
    let enableWebSearch = request.enableWebSearch ?? false
    
    // Auto-enable based on model name (if not explicitly set)
    if (!enableThinking && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Kimi] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Kimi] Web search enabled (from model name)')
    }

    const payload = createKimiChatPayload({
      model: request.model,
      content,
      enableWebSearch,
      enableThinking,
    })
    const frameBuffer = encodeKimiGrpcFrame(payload)

    console.log('[Kimi] Request body length:', frameBuffer.length, 'JSON length:', frameBuffer.length - 5)

    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
      frameBuffer,
      applyAxiosProxyConfig({
        headers: this.buildWebHeaders(accessToken, 'application/connect+json'),
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }, this.outboundProxy)
    )

    console.log('[Kimi] Completion response status:', response.status)

    if (response.status === 401) {
      accessTokenMap.delete(this.token)
      throw new Error('Token invalid or expired')
    }

    if (response.status !== 200) {
      throw new Error(`Completion request failed: HTTP ${response.status}`)
    }

    return { response, conversationId: '' }
  }

  async createShareLink(
    chatId: string | undefined,
    messageId?: string,
    messageIds: string[] = [],
    metadata: Pick<KimiChat2ApiInfo, 'citations' | 'search_results'> = {}
  ): Promise<KimiChat2ApiInfo | undefined> {
    if (!chatId) {
      return undefined
    }

    const normalizedMessageIds = uniqueStrings([messageId, ...messageIds])
    const baseInfo: KimiChat2ApiInfo = {
      provider: 'kimi',
      chat_id: chatId,
      ...(messageId ? { message_id: messageId } : {}),
      ...(normalizedMessageIds.length > 0 ? { message_ids: normalizedMessageIds } : {}),
      conversation_url: this.getConversationUrl(chatId),
      ...metadata,
    }

    try {
      const { accessToken } = await this.acquireToken()
      const response = await axios.post(
        `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/CreateChatShare`,
        {
          chat_id: chatId,
          message_ids: normalizedMessageIds,
        },
        applyAxiosProxyConfig({
          headers: {
            ...this.buildWebHeaders(accessToken, 'application/json'),
            Referer: `${this.getConversationUrl(chatId)}?chat_enter_method=new_chat`,
          },
          timeout: 15000,
          validateStatus: () => true,
        }, this.outboundProxy)
      )

      if (response.status !== 200) {
        return {
          ...baseInfo,
          share_error: response.data?.message || response.data?.msg || `HTTP ${response.status}`,
        }
      }

      const data = checkResult(response, this.token)
      const share = data?.share || data?.chatShare || data
      const shareId = pickString(
        share?.id,
        share?.shareId,
        share?.share_id,
        data?.shareId,
        data?.share_id,
        data?.id
      )
      const shareUrl = pickString(
        share?.url,
        share?.shareUrl,
        share?.share_url,
        data?.shareUrl,
        data?.share_url,
        data?.url
      )

      if (!shareId) {
        return {
          ...baseInfo,
          share_error: 'Kimi share id was not found',
        }
      }

      return {
        ...baseInfo,
        share_id: shareId,
        share_url: shareUrl || `${KIMI_API_BASE}/share/${encodeURIComponent(shareId)}`,
      }
    } catch (error) {
      return {
        ...baseInfo,
        share_error: error instanceof Error ? error.message : 'Failed to create Kimi share link',
      }
    }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const { accessToken } = await this.acquireToken()
      
      const response = await axios.post(
        `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/DeleteChat`,
        { chat_id: conversationId },
        applyAxiosProxyConfig({
          headers: this.buildWebHeaders(accessToken, 'application/json'),
          timeout: 15000,
          validateStatus: () => true,
        }, this.outboundProxy)
      )

      console.log('[Kimi] Chat deleted:', conversationId, 'Status:', response.status)
      return response.status === 200
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation:', error)
      return false
    }
  }

  private async listChats(pageToken?: string): Promise<{ chatIds: string[]; nextPageToken: string }> {
    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/ListChats`,
      {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
        query: '',
      },
      applyAxiosProxyConfig({
        headers: this.buildWebHeaders(accessToken, 'application/json'),
        timeout: 15000,
        validateStatus: () => true,
      }, this.outboundProxy)
    )

    const data = checkResult(response, this.token)
    const chats = Array.isArray(data?.chats) ? data.chats : []
    const chatIds = chats
      .map((chat: any) => typeof chat?.id === 'string' ? chat.id : '')
      .filter(Boolean)

    return {
      chatIds,
      nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
    }
  }

  private async batchDeleteChats(chatIds: string[]): Promise<boolean> {
    if (chatIds.length === 0) {
      return true
    }

    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats`,
      { chat_ids: chatIds },
      applyAxiosProxyConfig({
        headers: this.buildWebHeaders(accessToken, 'application/json'),
        timeout: 30000,
        validateStatus: () => true,
      }, this.outboundProxy)
    )

    checkResult(response, this.token)
    return response.status === 200
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allChatIds: string[] = []
      let pageToken = ''

      for (let page = 0; page < 100; page++) {
        const result = await this.listChats(pageToken || undefined)
        allChatIds = [...allChatIds, ...result.chatIds]

        if (!result.nextPageToken || result.chatIds.length === 0) {
          break
        }

        pageToken = result.nextPageToken
      }

      if (allChatIds.length === 0) {
        console.log('[Kimi] No chats to delete')
        return true
      }

      console.log('[Kimi] Found', allChatIds.length, 'chats to delete')

      for (let i = 0; i < allChatIds.length; i += 100) {
        const batch = allChatIds.slice(i, i + 100)
        const success = await this.batchDeleteChats(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Kimi] All chats deleted successfully')
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete all chats:', error)
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'

export interface KimiCitation {
  index: number
  title: string
  url: string
  snippet?: string
  siteName?: string
  iconUrl?: string
}

export interface KimiSearchSummary {
  keywords: string[]
  webPages: KimiCitation[]
}

export interface KimiChat2ApiInfo {
  provider: 'kimi'
  chat_id: string
  message_id?: string
  message_ids?: string[]
  conversation_url: string
  share_id?: string
  share_url?: string
  share_error?: string
  citations?: KimiCitation[]
  search_results?: KimiSearchSummary
}

export interface KimiCompletionMetadataContext {
  chat_id?: string
  message_id?: string
  message_ids?: string[]
  citations: KimiCitation[]
  search_results?: KimiSearchSummary
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function pickString(...values: any[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return values.reduce<string[]>((acc, value) => {
    if (typeof value !== 'string') {
      return acc
    }

    const normalized = value.trim()
    if (!normalized || acc.includes(normalized)) {
      return acc
    }

    return [...acc, normalized]
  }, [])
}

function pickPositiveInteger(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) {
      return Number(value)
    }
  }
  return undefined
}

function pickRefIndex(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue

    const direct = value.match(/^\d+$/)
    if (direct && Number(direct[0]) > 0) {
      return Number(direct[0])
    }

    const ref = value.match(/#(\d+)$/)
    if (ref) {
      return Number(ref[1]) + 1
    }
  }

  return undefined
}

function isKimiCitationReference(reference: any): boolean {
  return reference?.type === 2
    || reference?.type === 'CITE'
    || reference?.type === 'REFERENCE_TYPE_CITE'
}

function normalizeKimiSearchResult(raw: any, fallbackIndex: number): KimiCitation | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const contentValue = raw.content?.case === 'search'
    ? raw.content.value
    : raw.content?.value
  const source = contentValue
    || raw.searchResult
    || raw.search_result
    || raw.result
    || raw.search
    || raw.value
    || raw
  const base = source.base || source.page || source.webPage || source.web_page || source
  const url = pickString(
    source.url,
    source.uri,
    source.link,
    source.sourceUrl,
    source.source_url,
    base.url,
    base.uri,
    base.link,
    base.sourceUrl,
    base.source_url
  )

  if (!url) {
    return null
  }

  const index = pickPositiveInteger(
    source.id,
    source.index,
    source.cite_index,
    source.citeIndex,
    source.ref_index,
    source.refIndex,
    base.id,
    base.index,
    base.cite_index,
    base.citeIndex,
    base.ref_index,
    base.refIndex
  ) || pickRefIndex(source.refIndex, source.ref_index, base.refIndex, base.ref_index, raw.refIndex, raw.ref_index) || fallbackIndex

  const title = pickString(source.title, source.name, base.title, base.name, base.siteName, base.site_name) || url
  const snippet = pickString(source.snippet, source.summary, source.content, base.snippet, base.summary, base.content)
  const siteName = pickString(source.siteName, source.site_name, base.siteName, base.site_name)
  const iconUrl = pickString(source.iconUrl, source.icon_url, source.siteIcon, source.site_icon, base.iconUrl, base.icon_url, base.siteIcon, base.site_icon)

  return {
    index,
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(siteName ? { siteName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  }
}

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private enableThinking: boolean
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private userMessageId: string | null = null
  private hasError: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string = ''
  private searchKeywords: string[] = []
  private searchResults: KimiCitation[] = []
  private toolArgsById: Record<string, string> = {}
  private chat2api?: KimiChat2ApiInfo
  private metadataProvider?: (context: KimiCompletionMetadataContext) => Promise<KimiChat2ApiInfo | undefined>
  private isDone: boolean = false
  private isCompleting: boolean = false

  constructor(
    model: string,
    conversationId: string,
    enableThinking: boolean = false,
    toolCallingPlan?: ToolCallingPlan,
    metadataProvider?: (context: KimiCompletionMetadataContext) => Promise<KimiChat2ApiInfo | undefined>
  ) {
    this.model = model
    this.conversationId = conversationId
    this.enableThinking = enableThinking
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.metadataProvider = metadataProvider
  }

  getConversationId(): string | null {
    // Return realChatId if available, otherwise return null (not empty string)
    // to prevent saving invalid session IDs
    if (this.realChatId) {
      return this.realChatId
    }
    // Only return conversationId if it's a valid ID (not empty and not a temporary ID)
    if (this.conversationId && this.conversationId.length > 0 && !this.conversationId.startsWith('kimi-')) {
      return this.conversationId
    }
    return null
  }

  getLastMessageId(): string | null {
    return this.lastMessageId
  }

  getUserMessageId(): string | null {
    return this.userMessageId
  }

  getMessageIds(): string[] {
    return uniqueStrings([this.lastMessageId, this.userMessageId])
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  getSearchMetadata(): Pick<KimiChat2ApiInfo, 'citations' | 'search_results'> {
    const citations = this.createCitationList()
    const searchSummary = this.createSearchSummary()
    return {
      ...(citations.length > 0 ? { citations } : {}),
      ...(searchSummary ? { search_results: searchSummary } : {}),
    }
  }

  private detectMultiStage(data: any): 'thinking' | 'answer' | undefined {
    if (!data.block?.multiStage?.stages || !Array.isArray(data.block.multiStage.stages)) {
      return undefined
    }
    
    const stages = data.block.multiStage.stages
    if (stages.length === 0) {
      return undefined
    }
    
    const firstStage = stages[0]
    if (firstStage?.name === STAGE_NAME_THINKING) {
      return firstStage.status === 'completed' ? 'answer' : 'thinking'
    }
    
    return undefined
  }

  private isThinkingMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.think')
  }

  private isAnswerMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.text')
  }

  private extractThinkContent(data: any): string | null {
    return data.block?.think?.content || null
  }

  private extractTextContent(data: any): string | null {
    return data.block?.text?.content || null
  }

  private addSearchKeywords(keywords: any): void {
    for (const item of asArray(keywords)) {
      const keyword = typeof item === 'string'
        ? item
        : pickString(item?.keyword, item?.query, item?.text, item?.title, item?.content)
      if (keyword && !this.searchKeywords.includes(keyword)) {
        this.searchKeywords = [...this.searchKeywords, keyword]
      }
    }
  }

  private nextAvailableCitationIndex(): number {
    const usedIndexes = new Set(this.searchResults.map(item => item.index))
    let index = 1
    while (usedIndexes.has(index)) {
      index += 1
    }
    return index
  }

  private addSearchResults(results: any): void {
    for (const raw of asArray(results)) {
      const citation = normalizeKimiSearchResult(raw, this.nextAvailableCitationIndex())
      if (!citation) continue

      const existingIndex = this.searchResults.findIndex(item => item.url === citation.url)
      if (existingIndex >= 0) {
        const existing = this.searchResults[existingIndex]
        this.searchResults = [
          ...this.searchResults.slice(0, existingIndex),
          {
            ...existing,
            ...citation,
            index: existing.index || citation.index,
          },
          ...this.searchResults.slice(existingIndex + 1),
        ]
      } else {
        this.searchResults = [...this.searchResults, citation]
      }
    }
  }

  private collectToolArgs(block: any, op?: string, mask?: string): void {
    const args = block?.tool?.args
    if (typeof args !== 'string' || !args) {
      return
    }

    const toolKey = pickString(block.tool?.toolCallId, block.id, block.messageId) || 'default'
    const previousArgs = this.toolArgsById[toolKey] || ''
    const nextArgs = op === 'append' || mask?.includes('block.tool.args')
      ? `${previousArgs}${args}`
      : args

    this.toolArgsById = {
      ...this.toolArgsById,
      [toolKey]: nextArgs,
    }

    try {
      const parsed = JSON.parse(nextArgs)
      this.addSearchKeywords(parsed.queries ?? parsed.query ?? parsed.keywords ?? parsed.keyword)
    } catch {
      // Tool args arrive incrementally; ignore until a complete JSON object is available.
    }
  }

  private collectToolContents(contents: any): void {
    for (const item of asArray(contents)) {
      this.addSearchResults(
        item?.searchResult
        ?? item?.search_result
        ?? item?.result
        ?? item?.search
        ?? item
      )
    }
  }

  private collectToolArtifacts(block: any, op?: string, mask?: string): void {
    if (!block?.tool || typeof block.tool !== 'object') {
      return
    }

    this.collectToolArgs(block, op, mask)
    this.collectToolContents(block.tool.contents ?? block.tool.content)
  }

  private collectSearchBlock(block: any, op?: string, mask?: string): void {
    if (!block || typeof block !== 'object') return

    this.collectToolArtifacts(block, op, mask)

    const search = block.content?.case === 'search'
      ? block.content.value
      : block.search || block

    this.addSearchKeywords(search?.keywords ?? search?.keyword ?? search?.queries ?? search?.query ?? search?.searchQueries)
    this.addSearchResults(search?.webPages ?? search?.web_pages ?? search?.pages ?? search?.results)

    for (const step of asArray(search?.steps)) {
      this.addSearchKeywords(step?.keywords ?? step?.keyword ?? step?.queries ?? step?.query)
      this.addSearchResults(step?.webPages ?? step?.web_pages ?? step?.pages ?? step?.results)
    }
  }

  private collectRefs(refs: any): void {
    if (!refs || typeof refs !== 'object') return

    this.addSearchResults(refs.usedSearchChunks)
    this.addSearchResults(refs.used_search_chunks)
    this.addSearchResults(refs.searchChunks)
    this.addSearchResults(refs.search_chunks)
  }

  private collectReferences(references: any): void {
    for (const reference of asArray(references)) {
      if (!isKimiCitationReference(reference)) continue

      for (const item of asArray(reference.items ?? reference.item)) {
        if (item?.content?.case === 'search') {
          this.addSearchResults(item.content.value)
        } else {
          this.addSearchResults(item?.search ?? item?.value)
        }
      }
    }
  }

  private collectSearchArtifacts(data: any): void {
    this.collectSearchBlock(data.block, data.op, data.mask)

    if (data.event?.value) {
      this.collectSearchBlock(data.event.value)
    }

    if (data.ref) {
      this.addSearchResults(data.ref.search ?? data.ref)
    }

    if (data.refs) {
      this.collectRefs(data.refs)
    }
    if (data.references) {
      this.collectReferences(data.references)
    }

    if (data.message) {
      this.collectRefs(data.message.refs)
      this.collectReferences(data.message.references)

      for (const block of asArray(data.message.blocks)) {
        this.collectSearchBlock(block)
      }
    }
  }

  private createCitationList(): KimiCitation[] {
    return [...this.searchResults].sort((a, b) => a.index - b.index)
  }

  private createSearchSummary(): KimiSearchSummary | undefined {
    const webPages = this.createCitationList()
    if (this.searchKeywords.length === 0 && webPages.length === 0) {
      return undefined
    }

    return {
      keywords: [...this.searchKeywords],
      webPages,
    }
  }

  private async attachChat2ApiInfo(): Promise<void> {
    if (!this.metadataProvider) return

    try {
      const metadata = await this.metadataProvider({
        chat_id: this.getConversationId() || undefined,
        message_id: this.lastMessageId || undefined,
        message_ids: this.getMessageIds(),
        citations: this.createCitationList(),
        search_results: this.createSearchSummary(),
      })
      if (metadata) {
        this.chat2api = metadata
      }
    } catch (error) {
      console.error('[Kimi] Failed to attach chat2api metadata:', error)
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const created = unixTimestamp()
    let buffer = Buffer.alloc(0)
    let sentRole = false

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      this.processBuffer(buffer, transStream, created, (remaining) => { buffer = remaining }, () => sentRole, (v) => { sentRole = v })
    })

    stream.once('error', (err: Error) => {
      console.error('[Kimi] Stream error:', err.message)
      if (!transStream.closed) transStream.end('data: [DONE]\n\n')
    })

    stream.once('close', () => {
      console.log('[Kimi] Stream closed, realChatId:', this.realChatId, 'lastMessageId:', this.lastMessageId)
      if (!transStream.closed && !this.isDone && !this.isCompleting) {
        transStream.end('data: [DONE]\n\n')
      }
    })

    return transStream
  }

  private processBuffer(
    buffer: Buffer,
    transStream: PassThrough,
    created: number,
    setBuffer: (remaining: Buffer) => void,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    let offset = 0

    // gRPC-Web frame format: 1 byte flag + 4 bytes length (big-endian) + payload
    while (offset + 5 <= buffer.length) {
      const flag = buffer.readUInt8(offset)
      const length = buffer.readUInt32BE(offset + 1)

      if (offset + 5 + length > buffer.length) {
        break
      }

      const payload = buffer.slice(offset + 5, offset + 5 + length)

      try {
        const text = payload.toString('utf8')
        if (text.trim()) {
          const data = JSON.parse(text)
          
          // Check for error response
          if (data.error) {
            console.error('[Kimi] API Error:', data.error)
            this.hasError = true
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: `Error: ${data.error.message || JSON.stringify(data.error)}` }, finish_reason: null }],
              created,
            })}\n\n`)
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              created,
            })}\n\n`)
            transStream.end('data: [DONE]\n\n')
            return
          }
          
          this.handleMessage(data, transStream, created, getSentRole, setSentRole)
        }
      } catch (e) {
        // Skip invalid JSON
      }

      offset += 5 + length
    }

    setBuffer(buffer.slice(offset))
  }

  private handleMessage(
    data: any,
    transStream: PassThrough,
    created: number,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    if (data.heartbeat) return
    this.collectSearchArtifacts(data)

    if (data.chat?.id && !this.realChatId) {
      this.realChatId = data.chat.id
      console.log('[Kimi] Extracted real chat_id from chat.id:', this.realChatId)
    }

    if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
      this.lastMessageId = data.message.id
      console.log('[Kimi] Extracted assistant message id:', this.lastMessageId)
    }

    if (data.message?.id && data.message?.role === 'user' && !this.userMessageId) {
      this.userMessageId = data.message.id
      console.log('[Kimi] Extracted user message id:', this.userMessageId)
    }

    const multiStagePhase = this.detectMultiStage(data)
    if (multiStagePhase) {
      this.currentPhase = multiStagePhase
      console.log('[Kimi] Detected multiStage phase:', this.currentPhase)
    }

    if (data.block?.text?.flags === 'thinking') {
      this.currentPhase = 'thinking'
    } else if (data.block?.text?.flags === 'answer') {
      this.currentPhase = 'answer'
    }

    if ((data.op === 'set' || data.op === 'append')) {
      const mask = data.mask
      
      if (this.isThinkingMask(mask)) {
        const thinkContent = this.extractThinkContent(data)
        if (thinkContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.reasoningBuffer += thinkContent
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            created,
          })}\n\n`)
        }
      } else if (this.isAnswerMask(mask)) {
        const textContent = this.extractTextContent(data)
        if (textContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.sendChunk(transStream, textContent, created)
        }
      } else if (data.block?.text?.content) {
        const content = data.block.text.content
        
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            created,
          })}\n\n`)
          setSentRole(true)
        }
        
        if (this.currentPhase === 'thinking') {
          this.reasoningBuffer += content
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            created,
          })}\n\n`)
        } else {
          this.sendChunk(transStream, content, created)
        }
      }
    }

    if (data.done !== undefined) {
      void this.finishStream(transStream, created)
    }
  }

  private async finishStream(transStream: PassThrough, created: number): Promise<void> {
    if (this.isDone || transStream.closed) return
    this.isDone = true
    this.isCompleting = true

    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    await this.attachChat2ApiInfo()

    const finalChunk: any = {
      id: this.getConversationId(),
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop' }],
      created,
    }
    const citations = this.createCitationList()
    const searchSummary = this.createSearchSummary()
    if (citations.length > 0) {
      finalChunk.citations = citations
    }
    if (searchSummary) {
      finalChunk.search_results = searchSummary
    }
    if (this.chat2api) {
      finalChunk.chat2api = this.chat2api
    }

    transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
    transStream.end('data: [DONE]\n\n')
    this.isCompleting = false
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    // Process tool call interception
    // Use getConversationId() to get the real chat_id if available
    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const outputChunks = this.toolStreamParser?.push(content, baseChunk, false) ?? []

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (!this.toolStreamParser || (!this.toolStreamParser.isBuffering() && !this.toolStreamParser.hasEmittedToolCall() && !hasToolCalls && outputChunks.length === 0)) {
      transStream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
    }
  }

  private createNonStreamResponse(content: string, reasoningContent: string, created: number): any {
    const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
      ? { content, toolCalls: [] }
      : parseToolCallsFromText(content, 'kimi')

    const message: any = {
      role: 'assistant',
      content: toolCalls.length > 0 ? null : cleanContent.trim(),
    }

    if (reasoningContent.trim()) {
      message.reasoning_content = reasoningContent.trim()
    }

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }

    const citations = this.createCitationList()
    const searchSummary = this.createSearchSummary()
    if (citations.length > 0) {
      message.citations = citations
    }
    if (searchSummary) {
      message.search_results = searchSummary
    }

    return {
      id: this.realChatId || this.conversationId,
      model: this.model,
      object: 'chat.completion',
      created,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }

  async handleNonStream(stream: any): Promise<any> {
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    let buffer = Buffer.alloc(0)
    let currentPhase: 'thinking' | 'answer' | undefined = undefined

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])

        let offset = 0
        while (offset + 5 <= buffer.length) {
          const flag = buffer.readUInt8(offset)
          const length = buffer.readUInt32BE(offset + 1)

          if (offset + 5 + length > buffer.length) {
            break
          }

          const payload = buffer.slice(offset + 5, offset + 5 + length)

          try {
            const text = payload.toString('utf8')
            if (text.trim()) {
              const data = JSON.parse(text)

              if (data.error) {
                reject(new Error(`Kimi API Error: ${data.error.message || JSON.stringify(data.error)}`))
                return
              }

              this.collectSearchArtifacts(data)

              if (data.chat?.id && !this.realChatId) {
                this.realChatId = data.chat.id
                console.log('[Kimi] Non-stream: Extracted real chat_id from chat.id:', this.realChatId)
              }

              if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
                this.lastMessageId = data.message.id
                console.log('[Kimi] Non-stream: Extracted assistant message id:', this.lastMessageId)
              }

              if (data.message?.id && data.message?.role === 'user' && !this.userMessageId) {
                this.userMessageId = data.message.id
                console.log('[Kimi] Non-stream: Extracted user message id:', this.userMessageId)
              }

              const multiStagePhase = this.detectMultiStage(data)
              if (multiStagePhase) {
                currentPhase = multiStagePhase
                console.log('[Kimi] Non-stream: Detected multiStage phase:', currentPhase)
              }

              if (data.block?.text?.flags === 'thinking') {
                currentPhase = 'thinking'
              } else if (data.block?.text?.flags === 'answer') {
                currentPhase = 'answer'
              }

              if ((data.op === 'set' || data.op === 'append')) {
                const mask = data.mask
                
                if (this.isThinkingMask(mask)) {
                  const thinkContent = this.extractThinkContent(data)
                  if (thinkContent) {
                    reasoningContent += thinkContent
                  }
                } else if (this.isAnswerMask(mask)) {
                  const textContent = this.extractTextContent(data)
                  if (textContent) {
                    content += textContent
                  }
                } else if (data.block?.text?.content) {
                  const textContent = data.block.text.content
                  if (currentPhase === 'thinking') {
                    reasoningContent += textContent
                  } else {
                    content += textContent
                  }
                }
              }

              if (data.done !== undefined) {
                resolve(this.createNonStreamResponse(content, reasoningContent, created))
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }

          offset += 5 + length
        }

        buffer = buffer.slice(offset)
      })

      stream.once('error', reject)
      stream.once('close', () => {
        resolve(this.createNonStreamResponse(content, reasoningContent, created))
      })
    })
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
