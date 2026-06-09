/**
 * Qwen Adapter
 * Implements Qwen (Tongyi Qianwen) web API protocol
 * Based on new chat2.qianwen.com API
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected, shouldInjectToolPrompt } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import { applyAxiosProxyConfig, type OutboundProxyContext } from '../proxyTransport'

/**
 * Check if content contains tool calls (both bracket and XML formats)
 */
function hasToolCalls(content: string): boolean {
  return content.includes('[function_calls]') || hasToolUse(content)
}

const QWEN_API_BASE = 'https://chat2.qianwen.com'
const QWEN_CHAT2_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_CHAT_SIDE_API_BASE = 'https://chat-side.qianwen.com'

const MODEL_MAP: Record<string, string> = {
  'Qwen3.6': 'Qwen',
  'Qwen3.7-Max': 'Qwen3.7-Max',
  'Qwen3.5-Flash': 'Qwen3.5-Flash',
  'Qwen3-Max': 'Qwen3-Max',
  'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
  'Qwen3-Coder': 'Qwen3-Coder',
}

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[]
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: QwenMessage[]
  tools?: any[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  enableThinking?: boolean
  enableWebSearch?: boolean
}

interface QwenCitation {
  index: number
  title: string
  url: string
  snippet?: string
  siteName?: string
  iconUrl?: string
  source?: string
}

interface QwenSearchSummary {
  keywords: string[]
  webPages: QwenCitation[]
}

interface QwenChat2ApiInfo {
  provider: 'qwen'
  session_id?: string
  req_id?: string
  response_id?: string
  share_id?: string
  share_url?: string
  share_error?: string
}

interface QwenSessionListPage {
  sessionIds: string[]
  hasMore: boolean
  nextCursor: string
}

const SEARCH_RESULT_KEYS = new Set([
  'citation',
  'citations',
  'reference',
  'references',
  'searchresult',
  'searchresults',
  'webresult',
  'webresults',
  'webpage',
  'webpages',
  'source',
  'sources',
  'sourcelist',
  'sourceitems',
  'docs',
  'documents',
  'links',
  'pages',
  'results',
])

const SEARCH_KEYWORD_KEYS = new Set([
  'keyword',
  'keywords',
  'querykeyword',
  'queries',
  'searchqueries',
  'searchquery',
])

const RELATED_SEARCH_KEYS = new Set([
  'relatedsearch',
  'relatedsearches',
  'relatedquestion',
  'relatedquestions',
  'suggestion',
  'suggestions',
  'suggestedquestion',
  'suggestedquestions',
  'recommendquestion',
  'recommendquestions',
  'queryrecommend',
  'queryrecommends',
  'recommendquery',
  'recommendqueries',
])

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeKey(key: string | undefined): string {
  return (key || '').replace(/[_\-\s]/g, '').toLowerCase()
}

function pickString(...values: any[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
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

function normalizeUrl(value: any): string | undefined {
  const url = pickString(value)
  if (!url) return undefined

  if (/^https?:\/\//i.test(url)) {
    return url
  }
  if (url.startsWith('//')) {
    return `https:${url}`
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(url)) {
    return `https://${url}`
  }
  return undefined
}

function citationCandidates(raw: Record<string, any>): Record<string, any>[] {
  return [
    raw,
    raw.value,
    raw.data,
    raw.result,
    raw.search,
    raw.source,
    raw.page,
    raw.webPage,
    raw.web_page,
    raw.document,
    raw.doc,
    raw.base,
    raw.content?.value,
    raw.content,
  ].filter(isRecord)
}

function pickFromCandidates(candidates: Record<string, any>[], picker: (candidate: Record<string, any>) => any[]): string | undefined {
  for (const candidate of candidates) {
    const value = pickString(...picker(candidate))
    if (value) return value
  }
  return undefined
}

function normalizeQwenCitation(raw: any, fallbackIndex: number): QwenCitation | null {
  if (typeof raw === 'string') {
    const url = normalizeUrl(raw)
    return url ? { index: fallbackIndex, title: url, url } : null
  }

  if (!isRecord(raw)) {
    return null
  }

  const candidates = citationCandidates(raw)
  let url: string | undefined
  for (const candidate of candidates) {
    url = normalizeUrl(
      pickString(
        candidate.url,
        candidate.uri,
        candidate.link,
        candidate.href,
        candidate.sourceUrl,
        candidate.source_url,
        candidate.pageUrl,
        candidate.page_url,
        candidate.siteUrl,
        candidate.site_url,
        candidate.targetUrl,
        candidate.target_url,
        candidate.rawUrl,
        candidate.raw_url,
        candidate.displayUrl,
        candidate.display_url
      )
    )
    if (url) break
  }

  if (!url) {
    return null
  }

  const index = pickPositiveInteger(
    raw.index,
    raw.cite_index,
    raw.citeIndex,
    raw.ref_index,
    raw.refIndex,
    raw.number,
    raw.no
  ) || fallbackIndex

  const title = pickFromCandidates(candidates, candidate => [
    candidate.title,
    candidate.name,
    candidate.siteName,
    candidate.site_name,
    candidate.sourceName,
    candidate.source_name,
  ]) || url

  const snippet = pickFromCandidates(candidates, candidate => [
    candidate.snippet,
    candidate.summary,
    candidate.description,
    candidate.abstract,
    candidate.text,
    typeof candidate.content === 'string' ? candidate.content : undefined,
  ])

  const siteName = pickFromCandidates(candidates, candidate => [
    candidate.siteName,
    candidate.site_name,
    candidate.sourceName,
    candidate.source_name,
    candidate.host,
    candidate.domain,
  ])

  const iconUrl = pickFromCandidates(candidates, candidate => [
    candidate.iconUrl,
    candidate.icon_url,
    candidate.siteIcon,
    candidate.site_icon,
    candidate.favicon,
  ])

  const source = pickFromCandidates(candidates, candidate => [
    candidate.source,
    candidate.sourceType,
    candidate.source_type,
    candidate.type,
  ])

  return {
    index,
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(siteName ? { siteName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(source ? { source } : {}),
  }
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return ''
}

export class QwenAdapter {
  private provider: Provider
  private account: Account
  private outboundProxy?: OutboundProxyContext
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account, outboundProxy?: OutboundProxyContext) {
    this.provider = provider
    this.account = account
    this.outboundProxy = outboundProxy
  }

  private getTicket(): string {
    const credentials = this.account.credentials
    return credentials.ticket || credentials.tongyi_sso_ticket || ''
  }

  private mapModel(model: string): string {
    if (MODEL_MAP[model]) {
      return MODEL_MAP[model]
    }
    return model
  }

  private getApiHeaders(ticket: string): Record<string, string> {
    return {
      Cookie: `tongyi_sso_ticket=${ticket}`,
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
      'X-Platform': 'pc_tongyi',
      'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
    }
  }

  private getApiParams(extra: Record<string, string | number> = {}): Record<string, string | number> {
    return {
      biz_id: 'ai_qwen',
      chat_client: 'h5',
      device: 'pc',
      fr: 'pc',
      pr: 'qwen',
      ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
      la: 'zh_CN',
      tz: 'Asia/Shanghai',
      wv: '1',
      ve: '1',
      ...extra,
    }
  }

  private extractSessionIds(data: any): string[] {
    const candidateLists = [
      data?.data?.list,
      data?.data?.sessions,
      data?.data?.sessionList,
      data?.data?.records,
      data?.data?.items,
      data?.data?.dataList,
      data?.data?.result?.list,
      data?.data?.result?.records,
      data?.data?.pageData?.list,
      data?.data?.pageData?.records,
      data?.list,
      data?.sessions,
    ].filter(Array.isArray)

    const sessionIds = candidateLists.flatMap((items: any[]) => (
      items
        .map((item: any) => item?.session_id || item?.sessionId || item?.session?.id || item?.id)
        .filter((sessionId: any): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
    ))

    return [...new Set(sessionIds)]
  }

  private async listSessions(pageNum: number, cursor?: string): Promise<QwenSessionListPage> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v2/session/page/list`,
      {
        pageSize: 100,
        pageNum,
        ...(cursor ? { cursor } : {}),
      },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      throw new Error(`Qwen session list failed: HTTP ${response.status}`)
    }

    const data = response.data?.data || {}
    const nextCursor = data.nextCursor || data.next_cursor || data.cursor || ''

    return {
      sessionIds: this.extractSessionIds(response.data),
      hasMore: Boolean(data.hasMore ?? data.has_more ?? data.page?.hasMore ?? data.result?.hasMore),
      nextCursor: typeof nextCursor === 'string' ? nextCursor : '',
    }
  }

  private async deleteRelatedFileRecords(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return true
    }

    const timestamp = Date.now()
    const response = await axios.post(
      `${QWEN_CHAT_SIDE_API_BASE}/api/v2/file/record/delete`,
      { sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams({
          nonce: generateNonce(),
          timestamp,
        }),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      console.warn('[Qwen] Failed to delete related file records:', response.status, response.data)
      return false
    }

    return true
  }

  private async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return sessionIds.length === 0
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v1/session/delete/batch`,
      { session_ids: sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200) {
      console.warn(`[Qwen] Failed to delete sessions: status ${response.status}`)
      return false
    }

    const { success, code, msg } = response.data || {}
    if (success === false || (typeof code === 'number' && code !== 0)) {
      console.warn(`[Qwen] Failed to delete sessions: ${msg || 'Unknown error'}`)
      return false
    }

    const fileRecordSuccess = await this.deleteRelatedFileRecords(sessionIds)
    if (!fileRecordSuccess) {
      console.warn('[Qwen] Sessions deleted but related file record cleanup failed')
    }

    return true
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
    reqId: string
  }> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const reqId = uuid(false)
    const sessionId = uuid(false)
    
    let actualModel = this.mapModel(request.model)
    
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
      console.log('[Qwen] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Qwen] Web search enabled (from model name)')
    }

    // Map thinking mode to model
    if (enableThinking) {
      // Use thinking model if available
      if (actualModel === 'Qwen3-Max') {
        actualModel = 'Qwen3-Max-Thinking-Preview'
        console.log('[Qwen] Using thinking model:', actualModel)
      }
    }
    
    console.log('[Qwen] Session info:', {
      sessionId,
      reqId,
    })
    console.log('[Qwen] Using model:', actualModel)

    const toolProfile = getProviderToolProfile('qwen')

    // Build prompt content from conversation messages
    let systemPrompt = ''
    const conversationParts: string[] = []
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = extractTextContent(msg.content)
      } else if (msg.role === 'user') {
        conversationParts.push(extractTextContent(msg.content))
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        conversationParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))))
      } else if (msg.role === 'assistant') {
        conversationParts.push(`Assistant: ${extractTextContent(msg.content)}`)
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        conversationParts.push(toolProfile.formatToolResult({
          toolCallId: msg.tool_call_id,
          content: extractTextContent(msg.content),
        }))
      }
    }

    let userContent = conversationParts.join('\n\n')

    // Inject tools prompt if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      const toolsPrompt = toolsToSystemPrompt(request.tools)
      systemPrompt = systemPrompt 
        ? systemPrompt + '\n\n' + toolsPrompt 
        : toolsPrompt
      // Add tool wrap hint to user content
      userContent = userContent + TOOL_WRAP_HINT
    }

    // If system prompt exists, prepend it to user content
    const finalContent = systemPrompt 
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    const timestamp = Date.now()
    const nonce = generateNonce()

    const requestBody = {
      deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
      req_id: reqId,
      model: actualModel,
      scene: 'chat',
      session_id: sessionId,
      sub_scene: 'chat',
      temporary: false,
      messages: [
        {
          content: finalContent,
          mime_type: 'text/plain',
          meta_data: {
            ori_query: finalContent
          }
        }
      ],
      from: 'default',
      parent_req_id: '0',
      enable_search: enableWebSearch,
      biz_data: '{"entryPoint":"tongyigw"}',
      scene_param: 'first_turn',
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen'
    }

    const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${uuid(false)}&nonce=${nonce}&timestamp=${timestamp}`
    const url = `${QWEN_API_BASE}/api/v2/chat?${queryString}`

    console.log('[Qwen] Sending request to /api/v2/chat...')

    const response = await this.axiosInstance.post(url, requestBody, applyAxiosProxyConfig({
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `tongyi_sso_ticket=${ticket}`,
      },
      responseType: 'stream',
      timeout: 120000,
      decompress: false,
    }, this.outboundProxy))

    console.log('[Qwen] Response status:', response.status)
    console.log('[Qwen] Response headers:', JSON.stringify(response.headers, null, 2))

    return { response, sessionId, reqId }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      if (!sessionId) {
        return false
      }

      const success = await this.deleteSessions([sessionId])
      if (success) {
        console.log('[Qwen] Session deleted successfully:', sessionId)
      }
      return success
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete session:', errorMessage)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allSessionIds: string[] = []
      let nextCursor = ''

      for (let pageNum = 1; pageNum <= 100; pageNum++) {
        const result = await this.listSessions(pageNum, nextCursor || undefined)
        allSessionIds = [...allSessionIds, ...result.sessionIds]

        if (!result.hasMore || result.sessionIds.length === 0) {
          break
        }

        nextCursor = result.nextCursor
      }

      allSessionIds = [...new Set(allSessionIds)]

      if (allSessionIds.length === 0) {
        console.log('[Qwen] No sessions to delete')
        return true
      }

      console.log('[Qwen] Found', allSessionIds.length, 'sessions to delete')

      for (let i = 0; i < allSessionIds.length; i += 100) {
        const batch = allSessionIds.slice(i, i + 100)
        const success = await this.deleteSessions(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Qwen] All sessions deleted successfully')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete all sessions:', errorMessage)
      return false
    }
  }

  static isQwenProvider(provider: Provider): boolean {
    return provider.id === 'qwen' || provider.apiEndpoint.includes('qianwen.com') || provider.apiEndpoint.includes('aliyun.com')
  }
}

export class QwenStreamHandler {
  private sessionId: string = ''
  private model: string
  private created: number
  private onEnd?: (sessionId: string) => void
  private content: string = ''
  private responseId: string = ''
  private stopSent: boolean = false
  private toolCallsSent: boolean = false
  private hasError: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false
  private reqId: string = ''
  private searchKeywords: string[] = []
  private searchResults: QwenCitation[] = []
  private relatedSearches: string[] = []
  private shareId: string = ''
  private shareUrl: string = ''

  constructor(
    model: string,
    onEnd?: (sessionId: string) => void,
    toolCallingPlan?: ToolCallingPlan,
    sessionId: string = '',
    reqId: string = ''
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.sessionId = sessionId
    this.reqId = reqId
    this.responseId = reqId
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    // Use the new parser that supports both bracket and XML formats
    const { toolCalls } = parseToolCallsFromText(this.content, 'default')
    
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.sessionId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.sessionId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.(this.sessionId)
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

  private addSearchKeywords(keywords: any): void {
    for (const item of asArray(keywords)) {
      const keyword = typeof item === 'string'
        ? item.trim()
        : pickString(item?.keyword, item?.query, item?.text, item?.title, item?.content)

      if (keyword && !this.searchKeywords.includes(keyword)) {
        this.searchKeywords = [...this.searchKeywords, keyword]
      }
    }
  }

  private addRelatedSearches(related: any): void {
    for (const item of asArray(related)) {
      const question = typeof item === 'string'
        ? item.trim()
        : pickString(item?.query, item?.question, item?.title, item?.text, item?.content, item?.keyword)

      if (question && !this.relatedSearches.includes(question)) {
        this.relatedSearches = [...this.relatedSearches, question]
      }
    }
  }

  private addSearchResults(results: any): void {
    for (const raw of asArray(results)) {
      if (Array.isArray(raw)) {
        this.addSearchResults(raw)
        continue
      }

      const citation = normalizeQwenCitation(raw, this.nextAvailableCitationIndex())
      if (citation) {
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

      if (isRecord(raw)) {
        this.addSearchKeywords(raw.keywords ?? raw.keyword ?? raw.queries ?? raw.searchQueries ?? raw.search_queries)
        this.addSearchResults(raw.webPages ?? raw.web_pages ?? raw.pages ?? raw.results ?? raw.items ?? raw.list)
      }
    }
  }

  private collectShareCandidate(value: any): void {
    if (typeof value === 'string') {
      const url = normalizeUrl(value)
      if (url) {
        this.shareUrl = url
      }
      return
    }

    if (!isRecord(value)) return

    const shareUrl = normalizeUrl(
      pickString(value.share_url, value.shareUrl, value.url, value.link, value.href)
    )
    if (shareUrl) {
      this.shareUrl = shareUrl
    }

    const shareId = pickString(value.share_id, value.shareId, value.id)
    if (shareId) {
      this.shareId = shareId
    }
  }

  private collectSearchArtifacts(value: any, key?: string, depth: number = 0): void {
    if (value === undefined || value === null || depth > 8) {
      return
    }

    const normalizedKey = normalizeKey(key)

    if (SEARCH_KEYWORD_KEYS.has(normalizedKey)) {
      this.addSearchKeywords(value)
    }
    if (RELATED_SEARCH_KEYS.has(normalizedKey)) {
      this.addRelatedSearches(value)
    }
    if (normalizedKey.includes('share')) {
      this.collectShareCandidate(value)
    }
    if (SEARCH_RESULT_KEYS.has(normalizedKey)) {
      this.addSearchResults(value)
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectSearchArtifacts(item, key, depth + 1)
      }
      return
    }

    if (!isRecord(value)) {
      return
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      this.collectSearchArtifacts(childValue, childKey, depth + 1)
    }
  }

  private createCitationList(): QwenCitation[] {
    return [...this.searchResults].sort((a, b) => a.index - b.index)
  }

  private createSearchSummary(): QwenSearchSummary | undefined {
    const webPages = this.createCitationList()
    if (this.searchKeywords.length === 0 && webPages.length === 0) {
      return undefined
    }

    return {
      keywords: [...this.searchKeywords],
      webPages,
    }
  }

  private createChat2ApiInfo(): QwenChat2ApiInfo {
    const reqId = this.responseId || this.reqId
    const info: QwenChat2ApiInfo = {
      provider: 'qwen',
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      ...(this.reqId ? { req_id: this.reqId } : {}),
      ...(reqId && reqId !== this.reqId ? { response_id: reqId } : {}),
      ...(this.shareId ? { share_id: this.shareId } : {}),
      ...(this.shareUrl ? { share_url: this.shareUrl } : {}),
    }

    if (!info.share_url) {
      info.share_error = 'Qwen share link endpoint is not implemented yet'
    }

    return info
  }

  private attachMetadataToResponse(data: any): void {
    const message = data?.choices?.[0]?.message
    if (message && typeof message === 'object') {
      const citations = this.createCitationList()
      const searchSummary = this.createSearchSummary()
      if (citations.length > 0) {
        message.citations = citations
      }
      if (searchSummary) {
        message.search_results = searchSummary
      }
      if (this.relatedSearches.length > 0) {
        message.related_searches = [...this.relatedSearches]
      }
    }

    data.chat2api = this.createChat2ApiInfo()
  }

  private createFinalChunk(finishReason: 'stop' | 'tool_calls'): any {
    const finalChunk: any = {
      id: this.responseId || this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: this.created,
      chat2api: this.createChat2ApiInfo(),
    }

    const citations = this.createCitationList()
    const searchSummary = this.createSearchSummary()
    if (citations.length > 0) {
      finalChunk.citations = citations
    }
    if (searchSummary) {
      finalChunk.search_results = searchSummary
    }
    if (this.relatedSearches.length > 0) {
      finalChunk.related_searches = [...this.relatedSearches]
    }

    return finalChunk
  }

  handleStream(stream: any, response?: AxiosResponse): PassThrough {
    const transStream = new PassThrough()

    console.log('[Qwen] Starting stream handler...')
    
    const contentEncoding = response?.headers?.['content-encoding']
    console.log('[Qwen] Content-Encoding:', contentEncoding)

    let buffer = ''
    let streamEnded = false

    const safeEnd = (data?: string) => {
      if (streamEnded) return
      streamEnded = true
      if (data) {
        transStream.end(data)
      } else {
        transStream.end()
      }
    }

    const processBuffer = () => {
      while (true) {
        const doubleNewlineIndex = buffer.indexOf('\n\n')
        if (doubleNewlineIndex === -1) break

        const eventBlock = buffer.substring(0, doubleNewlineIndex)
        buffer = buffer.substring(doubleNewlineIndex + 2)

        const lines = eventBlock.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.substring(5)
          }
        }

        if (eventData && eventData !== '[DONE]') {
          try {
            const result = JSON.parse(eventData)
            console.log('[Qwen] Parsed event:', eventType, 'data keys:', Object.keys(result))
            this.collectSearchArtifacts(result)
            if (result.data?.messages) {
              console.log('[Qwen] Messages count:', result.data.messages.length)
              for (const msg of result.data.messages) {
                console.log('[Qwen] Message:', msg.mime_type, 'status:', msg.status, 'content length:', msg.content?.length || 0)
              }
            }

            if (result.communication) {
              if (result.communication.sessionid) {
                this.sessionId = result.communication.sessionid
              }
              if (result.communication.reqid) {
                this.reqId = result.communication.reqid
              }
              if (result.communication.reqid) {
                this.responseId = result.communication.reqid
              }
            }

            if (result.data?.messages) {
              // First pass: collect thinking content and answer content
              // Strategy: only use deep_think type to avoid duplicate content from multimodal_chat_think
              let eventThinkingContent = ''
              let eventThinkingType = ''
              const eventMessages: Array<{ msg: any, hasMultiLoad: boolean }> = []

              for (const msg of result.data.messages) {
                console.log('[Qwen] Message detail:', JSON.stringify(msg).substring(0, 500))

                // Collect thinking content from meta_data.multi_load
                const metaData = msg.meta_data || {}
                const multiLoad = metaData.multi_load || []
                let msgHasMultiLoad = false
                for (const load of multiLoad) {
                  if (load.type === 'deep_think' && load.content) {
                    // Only use deep_think type for thinking content
                    // multimodal_chat_think may contain slightly different content causing duplicates
                    const newThinkingContent = load.content.think_content || load.content.content || ''
                    if (newThinkingContent.length > eventThinkingContent.length) {
                      eventThinkingContent = newThinkingContent
                      eventThinkingType = load.type
                    }
                    msgHasMultiLoad = true
                  } else if (load.type === 'multimodal_chat_think') {
                    // Only fall back to multimodal_chat_think if no deep_think exists in this event
                    if (!msgHasMultiLoad && load.content) {
                      const newThinkingContent = load.content.think_content || load.content.content || ''
                      if (newThinkingContent.length > eventThinkingContent.length) {
                        eventThinkingContent = newThinkingContent
                        eventThinkingType = load.type
                      }
                      msgHasMultiLoad = true
                    }
                  }
                }
                eventMessages.push({ msg, hasMultiLoad: msgHasMultiLoad })
              }

              // Process thinking content (once per event, only before answer phase starts)
              // Once answer content has been sent (sentRole), stop emitting reasoning_content
              if (!this.sentRole && eventThinkingContent.length > this.thinkingContent.length) {
                const chunk = eventThinkingContent.substring(this.thinkingContent.length)
                this.thinkingContent = eventThinkingContent
                console.log('[Qwen] Thinking chunk, length:', chunk.length, 'content:', chunk.substring(0, 50), 'type:', eventThinkingType, 'prev:', this.thinkingContent.length - chunk.length, '->', this.thinkingContent.length)

                if (chunk.trim()) {
                  // Send reasoning_content delta
                  if (!this.sentThinkingRole) {
                    transStream.write(`data: ${JSON.stringify({
                      id: this.responseId || this.sessionId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`)
                    this.sentThinkingRole = true
                  }

                  transStream.write(`data: ${JSON.stringify({
                    id: this.responseId || this.sessionId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
                    created: this.created,
                  })}\n\n`)
                }
              }

              // Second pass: process answer content and completion status
              for (const { msg } of eventMessages) {
                
                // Filter out [(deep_think)] and [(multimodal_chat_think_*)] markers from content
                if ((msg.mime_type === 'text/plain' || msg.mime_type === 'multi_load/iframe') && msg.content) {
                  // Skip content that is just the deep_think marker
                  let newContent = msg.content
                  if (newContent === '[(deep_think)]' || newContent.trim() === '[(deep_think)]') {
                    console.log('[Qwen] Skipping deep_think marker')
                    continue
                  }
                  // Remove any deep_think and multimodal_chat_think markers from content
                  newContent = newContent.replace(/\[\(deep_think\)\]/g, '')
                  newContent = newContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                  
                  if (!newContent.trim()) {
                    console.log('[Qwen] Skipping empty content after filtering')
                    continue
                  }
                  
                  console.log('[Qwen] newContent.length:', newContent.length, 'this.content.length:', this.content.length)
                  if (newContent.length > this.content.length) {
                    const chunk = newContent.substring(this.content.length)
                    this.content = newContent
                    console.log('[Qwen] Writing chunk, length:', chunk.length)

                    // Process tool call interception
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !this.sentRole) ?? [{
                      ...baseChunk,
                      choices: [{ index: 0, delta: { ...(!this.sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
                    }]

                    for (const outChunk of outputChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }

                    if (outputChunks.length > 0) this.sentRole = true
                    console.log('[Qwen] Chunk written to stream')
                  } else {
                    console.log('[Qwen] Skipping - no new content')
                  }
                }

                if (msg.status === 'complete' || msg.status === 'finished') {
                  // 只有当 multi_load/iframe 消息完成时才发送 stop
                  if (msg.mime_type === 'multi_load/iframe' && !this.stopSent) {
                    this.stopSent = true
                    console.log('[Qwen] Sending stop for multi_load/iframe, content so far:', this.content.length)
                    
                    // Flush any remaining tool calls
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
                    
                    for (const outChunk of flushChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }
                    
                    // Check if we emitted tool calls
                    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
                    
                    transStream.write(`data: ${JSON.stringify(this.createFinalChunk(finishReason))}\n\n`)
                    safeEnd('data: [DONE]\n\n')
                    this.onEnd?.(this.sessionId)
                  }
                }
              }
            }

            if (result.error_code && result.error_code !== 0) {
              console.error('[Qwen] API error:', result.error_code, result.error_msg)
              this.hasError = true
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.responseId || this.sessionId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: `\n[Error: ${result.error_msg || result.error_code}]` }, finish_reason: 'stop' }],
                  created: this.created,
                })}\n\n`
              )
              safeEnd('data: [DONE]\n\n')
            }
          } catch (err) {
            console.error('[Qwen] Parse error:', err, 'Data:', eventData.substring(0, 200))
          }
        }

        if (eventType === 'complete') {
          console.log('[Qwen] Received complete event')
          if (!streamEnded && !this.stopSent) {
            this.stopSent = true
            
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
            const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            // Check if we emitted tool calls
            const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
            
            transStream.write(`data: ${JSON.stringify(this.createFinalChunk(finishReason))}\n\n`)
            safeEnd('data: [DONE]\n\n')
          }
        }
      }
    }

    let decompressStream: any = stream
    
    if (contentEncoding === 'gzip') {
      console.log('[Qwen] Decompressing gzip stream...')
      decompressStream = stream.pipe(createGunzip())
    } else if (contentEncoding === 'deflate') {
      console.log('[Qwen] Decompressing deflate stream...')
      decompressStream = stream.pipe(createInflate())
    } else if (contentEncoding === 'br') {
      console.log('[Qwen] Decompressing brotli stream...')
      decompressStream = stream.pipe(createBrotliDecompress())
    } else if (contentEncoding === 'zstd') {
      console.log('[Qwen] Decompressing zstd stream...')
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => {
        if (streamEnded) return
        try {
          const compressedData = Buffer.concat(chunks)
          ZstdCodec.run((zstd) => {
            const simple = new zstd.Simple()
            const decompressed = simple.decompress(compressedData)
            const decompressedStr = Buffer.from(decompressed).toString('utf8')
            buffer = decompressedStr
            processBuffer()
            safeEnd('data: [DONE]\n\n')
          })
        } catch (err) {
          console.error('[Qwen] Zstd decompression error:', err)
          safeEnd('data: [DONE]\n\n')
        }
      })
      stream.once('error', (err: Error) => {
        console.error('[Qwen] Stream error:', err)
        safeEnd('data: [DONE]\n\n')
      })
      return transStream
    }

    decompressStream.on('data', (bufferChunk: Buffer) => {
      if (streamEnded) return
      buffer += bufferChunk.toString()
      processBuffer()
    })
    decompressStream.once('error', (err: Error) => {
      console.error('[Qwen] Stream error:', err)
      safeEnd('data: [DONE]\n\n')
    })
    decompressStream.once('close', () => {
      console.log('[Qwen] Stream closed')
      if (streamEnded) return
      processBuffer()
      safeEnd('data: [DONE]\n\n')
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    console.log('[Qwen] Starting non-stream handler...')

    return new Promise((resolve, reject) => {
      const data: {
        id: string
        model: string
        object: string
        choices: Array<{
          index: number
          message: {
            role: string
            content: string | null
            reasoning_content?: string
            tool_calls?: any[]
            citations?: QwenCitation[]
            search_results?: QwenSearchSummary
            related_searches?: string[]
          }
          finish_reason: string
        }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        created: number
        chat2api?: QwenChat2ApiInfo
      } = {
        id: this.responseId || this.sessionId,
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let contentAccumulator = ''
      let thinkingAccumulator = ''
      let buffer = ''
      let resolved = false

      const finalizeWithData = (content: string) => {
        const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
          ? { content, toolCalls: [] }
          : parseToolCallsFromText(content, 'qwen')
        if (toolCalls.length > 0) {
          data.choices[0].message.content = null
          data.choices[0].message.tool_calls = toolCalls
          data.choices[0].finish_reason = 'tool_calls'
        } else {
          data.choices[0].message.content = cleanContent.trim()
        }
      }

      const resolveWithMetadata = () => {
        if (resolved) return
        this.attachMetadataToResponse(data)
        resolved = true
        resolve(data)
      }

      const processBuffer = () => {
        while (true) {
          const doubleNewlineIndex = buffer.indexOf('\n\n')
          if (doubleNewlineIndex === -1) break

          const eventBlock = buffer.substring(0, doubleNewlineIndex)
          buffer = buffer.substring(doubleNewlineIndex + 2)

          const lines = eventBlock.split('\n')
          let eventType = 'message'
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.substring(6).trim()
            } else if (line.startsWith('data:')) {
              eventData = line.substring(5)
            }
          }

          if (eventData && eventData !== '[DONE]') {
            try {
              const result = JSON.parse(eventData)
              console.log('[Qwen] Non-stream parsed event:', eventType, 'data keys:', Object.keys(result))
              this.collectSearchArtifacts(result)

              if (result.communication) {
                if (result.communication.sessionid) {
                  data.id = result.communication.sessionid
                  this.sessionId = result.communication.sessionid
                }
                if (result.communication.reqid) {
                  this.reqId = result.communication.reqid
                }
                if (result.communication.reqid) {
                  this.responseId = result.communication.reqid
                }
              }

              if (result.data?.messages) {
                for (const msg of result.data.messages) {
                  // Handle thinking content from meta_data.multi_load
                  // Strategy: prefer deep_think, fall back to multimodal_chat_think only if no deep_think
                  const metaData = msg.meta_data || {}
                  const multiLoad = metaData.multi_load || []
                  let hasDeepThink = false
                  for (const load of multiLoad) {
                    if (load.type === 'deep_think' && load.content) {
                      const thinkContent = load.content.think_content || load.content.content || ''
                      if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                        thinkingAccumulator = thinkContent
                        console.log('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: deep_think')
                      }
                      hasDeepThink = true
                    }
                  }
                  // Fall back to multimodal_chat_think only if no deep_think found
                  if (!hasDeepThink) {
                    for (const load of multiLoad) {
                      if (load.type === 'multimodal_chat_think' && load.content) {
                        const thinkContent = load.content.think_content || load.content.content || ''
                        if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                          thinkingAccumulator = thinkContent
                          console.log('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: multimodal_chat_think (fallback)')
                        }
                      }
                    }
                  }
                  
                  // Handle multi_load/iframe content (actual response content)
                  if (msg.mime_type === 'multi_load/iframe' && msg.content) {
                    // Filter out deep_think and multimodal_chat_think markers
                    let filteredContent = msg.content
                    if (filteredContent === '[(deep_think)]' || filteredContent.trim() === '[(deep_think)]') {
                      console.log('[Qwen] Non-stream: Skipping deep_think marker')
                      continue
                    }
                    // Filter out all think markers: [(deep_think)], [(multimodal_chat_think_*)]
                    filteredContent = filteredContent.replace(/\[\(deep_think\)\]/g, '')
                    filteredContent = filteredContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                      console.log('[Qwen] Non-stream multi_load/iframe content length:', contentAccumulator.length)
                    }
                  }
                  
                  // Also handle text/plain content
                  if (msg.mime_type === 'text/plain' && msg.content) {
                    // Filter out deep_think and multimodal_chat_think markers
                    let filteredContent = msg.content.replace(/\[\(deep_think\)\]/g, '')
                    filteredContent = filteredContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                    }
                  }

                  if (msg.status === 'complete' || msg.status === 'finished') {
                    if (msg.mime_type === 'multi_load/iframe') {
                      console.log('[Qwen] Non-stream finished, content length:', contentAccumulator.length)
                      this.content = contentAccumulator
                      
                      // Parse tool calls from content
                      const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
                        ? { content: contentAccumulator, toolCalls: [] }
                        : parseToolCallsFromText(contentAccumulator, 'qwen')
                      
                      if (toolCalls.length > 0) {
                        data.choices[0].message.content = null
                        ;(data.choices[0].message as any).tool_calls = toolCalls
                        data.choices[0].finish_reason = 'tool_calls'
                      } else {
                        data.choices[0].message.content = cleanContent.trim()
                      }
                      
                      // Add reasoning_content if available
                      if (thinkingAccumulator) {
                        data.choices[0].message.reasoning_content = thinkingAccumulator
                      }
                      
                      this.onEnd?.(this.sessionId)
                      resolveWithMetadata()
                      return
                    }
                  }
                }
              }
            } catch (err) {
              console.error('[Qwen] Non-stream parse error:', err)
            }
          }

          if (eventType === 'complete' && !resolved) {
            console.log('[Qwen] Non-stream complete event, content length:', contentAccumulator.length)
            this.content = contentAccumulator
            finalizeWithData(contentAccumulator)
            // Add reasoning_content if available
            if (thinkingAccumulator) {
              data.choices[0].message.reasoning_content = thinkingAccumulator
            }
            resolveWithMetadata()
            return
          }
        }
      }

      let decompressStream: any = stream
      
      const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
      if (contentEncoding === 'gzip') {
        console.log('[Qwen] Decompressing gzip stream...')
        decompressStream = stream.pipe(createGunzip())
      } else if (contentEncoding === 'deflate') {
        console.log('[Qwen] Decompressing deflate stream...')
        decompressStream = stream.pipe(createInflate())
      } else if (contentEncoding === 'br') {
        console.log('[Qwen] Decompressing brotli stream...')
        decompressStream = stream.pipe(createBrotliDecompress())
      } else if (contentEncoding === 'zstd') {
        console.log('[Qwen] Decompressing zstd stream...')
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.once('end', () => {
          try {
            const compressedData = Buffer.concat(chunks)
            ZstdCodec.run((zstd) => {
              const simple = new zstd.Simple()
              const decompressed = simple.decompress(compressedData)
              const decompressedStr = Buffer.from(decompressed).toString('utf8')
              buffer = decompressedStr
              processBuffer()
              console.log('[Qwen] Zstd non-stream finished, content length:', contentAccumulator.length)
              this.content = contentAccumulator
              finalizeWithData(contentAccumulator)
              // Add reasoning_content if available
              if (thinkingAccumulator) {
                data.choices[0].message.reasoning_content = thinkingAccumulator
              }
              resolveWithMetadata()
            })
          } catch (err) {
            console.error('[Qwen] Zstd decompression error:', err)
            reject(err)
          }
        })
        stream.once('error', (err: Error) => {
          console.error('[Qwen] Non-stream error:', err)
          reject(err)
        })
        return
      }

      decompressStream.on('data', (chunk: Buffer) => {
        if (resolved) return
        buffer += chunk.toString()
        processBuffer()
      })
      decompressStream.once('error', (err: Error) => {
        if (resolved) return
        console.error('[Qwen] Non-stream error:', err)
        reject(err)
      })
      decompressStream.once('close', () => {
        console.log('[Qwen] Non-stream closed, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          // Add reasoning_content if available
          if (thinkingAccumulator) {
            data.choices[0].message.reasoning_content = thinkingAccumulator
          }
          resolveWithMetadata()
        }
      })
      decompressStream.once('end', () => {
        console.log('[Qwen] Non-stream ended, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          // Add reasoning_content if available
          if (thinkingAccumulator) {
            data.choices[0].message.reasoning_content = thinkingAccumulator
          }
          resolveWithMetadata()
        }
      })
    })
  }

  getSessionId(): string {
    return this.sessionId
  }
}

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}
