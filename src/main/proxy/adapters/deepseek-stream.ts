/**
 * DeepSeek Stream Response Handler
 * Converts DeepSeek SSE stream to OpenAI compatible format
 */

import { PassThrough } from 'stream'
import { parseToolCallsFromText } from '../utils/toolParser.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'
import type { DeepSeekMessageId, DeepSeekShareInfo } from './deepseek.ts'
import { appendDebugTraceEvent } from '../debugTrace.ts'

const MODEL_NAME = 'deepseek-chat'
const SEARCH_CONTROL_MARKER_PATTERN = /^(SEARCH|WEB_SEARCH|SEARCHING)(?:\s+|$)/i
const INLINE_CITATION_MARKER_PATTERN = /\[citation:(\d+)\]/g
const STRIP_INLINE_CITATION_MARKER_PATTERN = /\s*\[citation:\d+\]/g

function stripSearchControlMarker(content: string, enabled: boolean): string {
  return enabled ? content.replace(SEARCH_CONTROL_MARKER_PATTERN, '') : content
}

function formatInlineCitationMarkers(content: string, enabled: boolean, preserveMarkers: boolean): string {
  if (!enabled) return content
  return preserveMarkers
    ? content
    : content.replace(STRIP_INLINE_CITATION_MARKER_PATTERN, '')
}

interface StreamChunk {
  p?: string
  v?: any
  request_message_id?: DeepSeekMessageId
  response_message_id?: DeepSeekMessageId
  o?: string
}

interface DeepSeekCitation {
  index: number
  cite_index: number
  title: string
  url: string
  [key: string]: any
}

const RELATED_SEARCH_KEYS = [
  'related_searches',
  'relatedSearches',
  'related_questions',
  'relatedQuestions',
  'suggested_questions',
  'suggestedQuestions',
  'follow_up_questions',
  'followUpQuestions',
]

function createBaseChunk(id: string, model: string, created: number) {
  return {
    id,
    model,
    object: 'chat.completion.chunk',
    created
  }
}

export class DeepSeekStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private requestMessageId: DeepSeekMessageId | undefined
  private messageId: DeepSeekMessageId | undefined
  private currentPath: string = ''
  private searchResults: any[] = []
  private searchQueries: string[] = []
  private relatedSearches: string[] = []
  private thinkingStarted: boolean = false
  private accumulatedTokenUsage: number = 2
  private created: number
  private onEnd?: (shareInfo: DeepSeekShareInfo | undefined, finishReason: string) => void
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private webSearchEnabled: boolean
  private reasoningEffort: string | undefined
  private isDone: boolean = false
  private semanticModel: string
  private shareInfo?: DeepSeekShareInfo
  private shareInfoProvider?: (
    messageId: DeepSeekMessageId | undefined,
    messageIds: DeepSeekMessageId[] | undefined,
  ) => Promise<DeepSeekShareInfo | undefined>
  private debugRaw: boolean
  private debugLogFile?: string
  private rawUpstreamEvents: string[] = []

  constructor(
    model: string,
    sessionId: string,
    onEnd?: (shareInfo: DeepSeekShareInfo | undefined, finishReason: string) => void,
    webSearchEnabled: boolean = false,
    reasoningEffort?: string,
    toolCallingPlan?: ToolCallingPlan,
    semanticModel?: string,
    shareInfoProvider?: (
      messageId: DeepSeekMessageId | undefined,
      messageIds: DeepSeekMessageId[] | undefined,
    ) => Promise<DeepSeekShareInfo | undefined>,
    debugRaw: boolean = false,
    debugLogFile?: string,
  ) {
    this.model = model
    this.semanticModel = (semanticModel || model).toLowerCase()
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.webSearchEnabled = webSearchEnabled
    this.reasoningEffort = reasoningEffort
    this.shareInfoProvider = shareInfoProvider
    this.debugRaw = debugRaw
    this.debugLogFile = debugLogFile
  }

  getLastMessageId(): DeepSeekMessageId | undefined {
    return this.messageId
  }

  getShareMessageIds(): DeepSeekMessageId[] | undefined {
    if (this.requestMessageId === undefined || this.messageId === undefined) {
      return undefined
    }

    return [this.requestMessageId, this.messageId]
  }

  private async attachShareInfo(): Promise<void> {
    if (!this.shareInfoProvider) return

    try {
      const shareInfo = await this.shareInfoProvider(this.messageId, this.getShareMessageIds())
      if (shareInfo) {
        this.shareInfo = shareInfo
      }
    } catch (error) {
      console.error('[DeepSeek] Failed to attach share info:', error)
    }
  }

  private isThinkingModel(): boolean {
    return this.semanticModel.includes('think')
      || this.semanticModel.includes('r1')
      || this.semanticModel.includes('reasoner')
      || !!this.reasoningEffort
  }

  private isFoldModel(isThinkingModel: boolean): boolean {
    return (this.semanticModel.includes('fold')
      || this.semanticModel.includes('search')
      || this.webSearchEnabled) && !isThinkingModel
  }

  private isSilentModel(): boolean {
    return this.semanticModel.includes('silent')
  }

  private isSearchSilentModel(): boolean {
    return this.semanticModel.includes('search-silent')
  }

  private shouldStripSearchControlMarker(): boolean {
    return this.webSearchEnabled || this.semanticModel.includes('search')
  }

  private shouldFormatInlineCitationMarkers(): boolean {
    return this.webSearchEnabled || this.semanticModel.includes('search')
  }

  private static normalizeSearchResult(result: any): any | null {
    if (!result || typeof result !== 'object') return null

    const url = result.url
    const title = result.title
    if (typeof url !== 'string' || typeof title !== 'string') return null

    const citeIndex = typeof result.cite_index === 'number'
      ? result.cite_index
      : typeof result.citeIndex === 'number'
        ? result.citeIndex
        : undefined

    const normalized = {
      ...result,
    }
    delete normalized.cite_index
    delete normalized.citeIndex
    if (typeof citeIndex === 'number' && Number.isFinite(citeIndex)) {
      normalized.cite_index = citeIndex
    }

    return normalized
  }

  private static mergeSearchResultsInto(target: any[], results: any[]): void {
    for (const result of results) {
      const normalized = DeepSeekStreamHandler.normalizeSearchResult(result)
      if (!normalized) continue

      const existingIndex = target.findIndex((item) => item.url === normalized.url)
      if (existingIndex >= 0) {
        target[existingIndex] = {
          ...target[existingIndex],
          ...normalized,
        }
      } else {
        target.push(normalized)
      }
    }
  }

  private static applySearchResultBatch(target: any[], operations: any[]): void {
    for (const op of operations) {
      const match = op?.p?.match(/^(\d+)\/cite_index$/)
      if (!match) continue

      const index = parseInt(match[1], 10)
      if (target[index] && typeof op.v === 'number' && Number.isFinite(op.v)) {
        target[index].cite_index = op.v
      }
    }
  }

  private static createCitationList(results: any[]): DeepSeekCitation[] {
    const seenUrls = new Set<string>()
    return results
      .filter(r => Number.isFinite(r.cite_index) && typeof r.url === 'string' && typeof r.title === 'string')
      .filter(r => {
        if (seenUrls.has(r.url)) return false
        seenUrls.add(r.url)
        return true
      })
      .sort((a, b) => a.cite_index - b.cite_index)
      .map(r => ({
        ...r,
        index: r.cite_index,
      }))
  }

  private static mergeTextValuesInto(target: string[], values: unknown): void {
    const entries = Array.isArray(values) ? values : [values]
    for (const entry of entries) {
      const text = DeepSeekStreamHandler.extractTextValue(entry)
      if (!text || target.includes(text)) {
        continue
      }
      target.push(text)
    }
  }

  private static extractTextValue(value: unknown): string | undefined {
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

  private static collectFragmentMetadata(
    fragment: any,
    searchQueries: string[],
    relatedSearches: string[],
  ): void {
    if (!fragment || typeof fragment !== 'object') {
      return
    }

    if (Array.isArray(fragment.queries)) {
      DeepSeekStreamHandler.mergeTextValuesInto(searchQueries, fragment.queries)
    }

    for (const key of RELATED_SEARCH_KEYS) {
      if (fragment[key] !== undefined) {
        DeepSeekStreamHandler.mergeTextValuesInto(relatedSearches, fragment[key])
      }
    }
  }

  private static collectFragmentSearchResults(fragment: any, searchResults: any[]): void {
    if (!fragment || typeof fragment !== 'object') {
      return
    }

    for (const key of ['results', 'references', 'search_results', 'searchResults', 'sources']) {
      if (Array.isArray(fragment[key])) {
        DeepSeekStreamHandler.mergeSearchResultsInto(searchResults, fragment[key])
      }
    }
  }

  private static collectBatchOperationMetadata(
    chunk: StreamChunk,
    searchResults: any[],
    searchQueries: string[],
    relatedSearches: string[],
  ): void {
    if (chunk.o !== 'BATCH' || !Array.isArray(chunk.v)) {
      return
    }

    for (const operation of chunk.v) {
      if (!operation || typeof operation !== 'object') {
        continue
      }

      const path = typeof operation.p === 'string' ? operation.p : ''
      const value = operation.v

      DeepSeekStreamHandler.collectChunkMetadata(
        { p: path, v: value, o: operation.o },
        searchQueries,
        relatedSearches,
      )

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        DeepSeekStreamHandler.collectFragmentMetadata(value, searchQueries, relatedSearches)
        DeepSeekStreamHandler.collectFragmentSearchResults(value, searchResults)
      }

      if (!Array.isArray(value)) {
        continue
      }

      if (path === 'fragments' || /(?:^|\/)fragments$/.test(path)) {
        for (const fragment of value) {
          DeepSeekStreamHandler.collectFragmentMetadata(fragment, searchQueries, relatedSearches)
          DeepSeekStreamHandler.collectFragmentSearchResults(fragment, searchResults)
        }
        continue
      }

      if (/search_results|searchResults|(?:^|\/)results$/i.test(path)) {
        if (operation.o === 'BATCH') {
          DeepSeekStreamHandler.applySearchResultBatch(searchResults, value)
        } else {
          DeepSeekStreamHandler.mergeSearchResultsInto(searchResults, value)
        }
      }
    }
  }

  private static collectChunkMetadata(
    chunk: StreamChunk,
    searchQueries: string[],
    relatedSearches: string[],
  ): void {
    const path = chunk.p || ''
    if (/queries$|search_queries|search\/queries/i.test(path)) {
      DeepSeekStreamHandler.mergeTextValuesInto(searchQueries, chunk.v)
    }
    if (RELATED_SEARCH_KEYS.some(key => path.toLowerCase().includes(key.toLowerCase()))) {
      DeepSeekStreamHandler.mergeTextValuesInto(relatedSearches, chunk.v)
    }

    if (chunk.v && typeof chunk.v === 'object' && chunk.v.response) {
      const response = chunk.v.response
      for (const key of RELATED_SEARCH_KEYS) {
        if (response[key] !== undefined) {
          DeepSeekStreamHandler.mergeTextValuesInto(relatedSearches, response[key])
        }
      }
    }
  }

  private parseSSE(data: string): StreamChunk | null {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  setShareInfo(shareInfo: DeepSeekShareInfo): void {
    this.shareInfo = shareInfo
  }

  private createChunk(
    delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: any[] },
    finishReason?: string,
    citations: DeepSeekCitation[] = [],
    searchQueries: string[] = [],
    relatedSearches: string[] = [],
  ): string {
    const chunk: any = {
      id: `${this.sessionId}@${this.messageId ?? ''}`,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
      created: this.created,
    }

    if (finishReason && this.shareInfo) {
      chunk.chat2api = this.shareInfo
    }

    if (finishReason && citations.length > 0) {
      chunk.citations = citations
    }

    if (finishReason && searchQueries.length > 0) {
      chunk.search_queries = searchQueries
    }

    if (finishReason && relatedSearches.length > 0) {
      chunk.related_searches = relatedSearches
    }

    if (finishReason && this.debugRaw) {
      chunk.chat2api_debug = {
        raw_upstream_events: this.rawUpstreamEvents,
      }
    }

    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    const isThinkingModel = this.isThinkingModel()
    const isSilentModel = this.isSilentModel()
    const isFoldModel = this.isFoldModel(isThinkingModel)
    const isSearchSilentModel = this.isSearchSilentModel()

    let buffer = ''

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          void this.handleDone(transStream, isFoldModel, isSearchSilentModel)
          return
        }

        if (this.debugRaw) {
          this.rawUpstreamEvents.push(data)
        }

        const parsed = this.parseSSE(data)
        if (!parsed) continue

        this.processChunk(parsed, transStream, isThinkingModel, isSilentModel, isFoldModel, isSearchSilentModel)
      }
    })

    stream.on('end', () => {
      void this.handleDone(transStream, isFoldModel, isSearchSilentModel)
    })

    stream.on('error', (err) => {
      transStream.emit('error', err)
    })

    return transStream
  }

  private processChunk(
    chunk: StreamChunk,
    transStream: PassThrough,
    isThinkingModel: boolean,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
    if (chunk.request_message_id !== undefined && this.requestMessageId === undefined) {
      this.requestMessageId = chunk.request_message_id
    }

    if (chunk.response_message_id !== undefined && this.messageId === undefined) {
      this.messageId = chunk.response_message_id
    }

    const previousPath = this.currentPath

    DeepSeekStreamHandler.collectChunkMetadata(chunk, this.searchQueries, this.relatedSearches)
    DeepSeekStreamHandler.collectBatchOperationMetadata(
      chunk,
      this.searchResults,
      this.searchQueries,
      this.relatedSearches,
    )

    if (chunk.v && typeof chunk.v === 'object' && chunk.v.response) {
      const isThinkingNow = chunk.v.response.thinking_enabled
      this.currentPath = isThinkingNow ? 'thinking' : 'content'
      if (chunk.v.response.parent_id !== undefined && this.requestMessageId === undefined) {
        this.requestMessageId = chunk.v.response.parent_id
      }
      if (chunk.v.response.message_id !== undefined && this.messageId === undefined) {
        this.messageId = chunk.v.response.message_id
      }
      
      const fragments = chunk.v.response.fragments
      if (Array.isArray(fragments) && fragments.length > 0) {
        for (const fragment of fragments) {
          DeepSeekStreamHandler.collectFragmentMetadata(fragment, this.searchQueries, this.relatedSearches)
          DeepSeekStreamHandler.collectFragmentSearchResults(fragment, this.searchResults)

          if (Array.isArray(fragment.results)) {
            DeepSeekStreamHandler.mergeSearchResultsInto(this.searchResults, fragment.results)
          }
          DeepSeekStreamHandler.collectFragmentSearchResults(fragment, this.searchResults)

          if (fragment.content) {
            const fragmentType = fragment.type
            const fragmentContent = fragment.content
            
            if (fragmentType === 'THINK') {
              this.sendContent(fragmentContent, 'thinking', transStream, isSilentModel, isFoldModel, isSearchSilentModel)
            } else if (fragmentType === 'ANSWER' || fragmentType === 'RESPONSE') {
              this.sendContent(fragmentContent, 'content', transStream, isSilentModel, isFoldModel, isSearchSilentModel)
            }
          }
        }
      }
    } else if (chunk.p === 'response/fragments') {
      if (Array.isArray(chunk.v)) {
        for (const fragment of chunk.v) {
          DeepSeekStreamHandler.collectFragmentMetadata(fragment, this.searchQueries, this.relatedSearches)
          DeepSeekStreamHandler.collectFragmentSearchResults(fragment, this.searchResults)

          if (fragment.content) {
            const fragmentType = fragment.type
            const fragmentContent = fragment.content
            
            if (fragmentType === 'THINK') {
              this.currentPath = 'thinking'
              this.sendContent(fragmentContent, 'thinking', transStream, isSilentModel, isFoldModel, isSearchSilentModel)
            } else if (fragmentType === 'ANSWER' || fragmentType === 'RESPONSE') {
              this.currentPath = 'content'
              this.sendContent(fragmentContent, 'content', transStream, isSilentModel, isFoldModel, isSearchSilentModel)
            }
          }
        }
      }
    } else if (chunk.p === 'response' && Array.isArray(chunk.v)) {
      const hasThinking = chunk.v.some((e: any) => 
        e.p === 'response' && e.v && typeof e.v === 'object' && e.v.thinking_enabled === true
      )
      if (hasThinking) {
        this.currentPath = 'thinking'
      }
    }

    if (chunk.p === 'response/search_status') return

    if (chunk.p === 'response' && Array.isArray(chunk.v)) {
      chunk.v.forEach((e: any) => {
        if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
          this.accumulatedTokenUsage = e.v
        }
      })
    }

    if (
      (chunk.p === 'response/search_results' || /^response\/fragments\/-?\d+\/results$/.test(chunk.p || ''))
      && Array.isArray(chunk.v)
    ) {
      if (chunk.o !== 'BATCH') {
        DeepSeekStreamHandler.mergeSearchResultsInto(this.searchResults, chunk.v)
      } else {
        DeepSeekStreamHandler.applySearchResultBatch(this.searchResults, chunk.v)
      }
      return
    }

    let content = ''
    if (typeof chunk.v === 'string') {
      content = chunk.v
    } else if (Array.isArray(chunk.v)) {
      content = chunk.v
        .map((e: any) => {
          if (Array.isArray(e.v)) {
            return e.v.map((v: any) => v.content).join('')
          }
          return ''
        })
        .join('')
    }

    if (!content) return

    // For thinking models, default to 'thinking' path if not set
    let effectivePath = this.currentPath
    if (!effectivePath && isThinkingModel) {
      effectivePath = 'thinking'
    }

    this.sendContent(content, effectivePath, transStream, isSilentModel, isFoldModel, isSearchSilentModel)
  }

  private sendContent(
    content: string,
    path: string,
    transStream: PassThrough,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
    const cleanedValue = content.replace(/FINISHED/g, '')
    const filteredForSearch = stripSearchControlMarker(cleanedValue, this.shouldStripSearchControlMarker())
    const shouldFormatInlineCitationMarkers = this.shouldFormatInlineCitationMarkers()
    const processedContent = formatInlineCitationMarkers(
      filteredForSearch,
      isSearchSilentModel || shouldFormatInlineCitationMarkers,
      !isSearchSilentModel && shouldFormatInlineCitationMarkers
    )

    // For 'content' path, intercept tool calls before text is streamed.
    if ((path === 'content' || path === '') && this.toolStreamParser) {
      const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
      const chunks = this.toolStreamParser.push(processedContent, baseChunk, this.isFirstChunk)
      
      // Send any chunks generated by tool call processing
      for (const chunk of chunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
        this.isFirstChunk = false
      }
      
      // If we're buffering a tool call or already emitted tool calls, don't send as regular content
      if (this.toolStreamParser.isBuffering() || this.toolStreamParser.hasEmittedToolCall()) {
        return
      }
      
      // If chunks were sent (regular content), we're done
      if (chunks.length > 0) {
        return
      }
    }

    const delta: { role?: string; content?: string; reasoning_content?: string } = {}
    let shouldSendDelta = true

    if (this.isFirstChunk) {
      delta.role = 'assistant'
    }

    if (path === 'thinking') {
      if (isSilentModel) return

      if (isFoldModel) {
        if (!this.thinkingStarted) {
          this.thinkingStarted = true
          delta.content = `<details><summary>Thinking Process</summary><pre>${processedContent}`
        } else {
          delta.content = processedContent
        }
      } else {
        if (processedContent) {
          delta.reasoning_content = processedContent
        } else {
          shouldSendDelta = false
        }
      }
    } else if (path === 'content') {
      if (isFoldModel && this.thinkingStarted) {
        delta.content = `</pre></details>${processedContent}`
        this.thinkingStarted = false
      } else {
        delta.content = processedContent
      }
    } else {
      delta.content = processedContent
    }

    if (shouldSendDelta && (delta.content !== undefined || delta.reasoning_content !== undefined)) {
      transStream.write(this.createChunk(delta))
      this.isFirstChunk = false
    }
  }

  private async handleDone(transStream: PassThrough, isFoldModel: boolean, isSearchSilentModel: boolean): Promise<void> {
    if (this.isDone) return
    this.isDone = true

    // Flush tool call buffer before finishing
    const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId ?? ''}`, this.model, this.created)
    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (isFoldModel && this.thinkingStarted) {
      transStream.write(this.createChunk({ content: '</pre></details>' }))
    }

    const citations = isSearchSilentModel
      ? []
      : DeepSeekStreamHandler.createCitationList(this.searchResults)

    await this.attachShareInfo()

    // Determine finish_reason based on whether we had tool calls
    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'

    this.appendRawUpstreamTrace('stream', finishReason)
    transStream.write(this.createChunk({}, finishReason, citations, this.searchQueries, this.relatedSearches))
    void this.onEnd?.(this.shareInfo, finishReason)
    transStream.write('data: [DONE]\n\n')
    transStream.end()
  }

  private appendRawUpstreamTrace(mode: 'stream' | 'non_stream', finishReason: string): void {
    if (!this.debugRaw) {
      return
    }

    appendDebugTraceEvent(this.debugLogFile, 'deepseek.upstream_sse', {
      provider: 'deepseek',
      mode,
      model: this.model,
      sessionId: this.sessionId,
      requestMessageId: this.requestMessageId,
      responseMessageId: this.messageId,
      finishReason,
      rawEvents: this.rawUpstreamEvents,
      rawEventCount: this.rawUpstreamEvents.length,
    })
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let accumulatedContent = ''
    let accumulatedThinkingContent = ''
    let messageId: DeepSeekMessageId | undefined
    let currentPath = ''
    let accumulatedTokenUsage = 2
    const searchResults: any[] = []
    const searchQueries: string[] = []
    const relatedSearches: string[] = []
    const isThinkingModel = this.isThinkingModel()
    const isFoldModel = this.isFoldModel(isThinkingModel)
    const isSearchSilentModel = this.isSearchSilentModel()
    const shouldStripSearchControlMarker = this.shouldStripSearchControlMarker()
    const shouldFormatInlineCitationMarkers = this.shouldFormatInlineCitationMarkers()
    const shouldProcessInlineCitationMarkers =
      isSearchSilentModel || shouldFormatInlineCitationMarkers
    const shouldPreserveInlineCitationMarkers =
      !isSearchSilentModel && shouldFormatInlineCitationMarkers

    return new Promise((resolve, reject) => {
      let buffer = ''

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (data === '[DONE]') return

          try {
            if (this.debugRaw) {
              this.rawUpstreamEvents.push(data)
            }

            const parsed = JSON.parse(data)
            
            if (parsed.request_message_id !== undefined && this.requestMessageId === undefined) {
              this.requestMessageId = parsed.request_message_id
            }

            if (parsed.response_message_id !== undefined && !messageId) {
              messageId = parsed.response_message_id
              this.messageId = parsed.response_message_id
            }

            DeepSeekStreamHandler.collectChunkMetadata(parsed, searchQueries, relatedSearches)
            DeepSeekStreamHandler.collectBatchOperationMetadata(
              parsed,
              searchResults,
              searchQueries,
              relatedSearches,
            )

            if (parsed.v && typeof parsed.v === 'object' && parsed.v.response) {
              const isThinkingNow = parsed.v.response.thinking_enabled
              if (isThinkingNow !== undefined) {
                currentPath = isThinkingNow ? 'thinking' : 'content'
              }
              if (parsed.v.response.parent_id !== undefined && this.requestMessageId === undefined) {
                this.requestMessageId = parsed.v.response.parent_id
              }
              if (parsed.v.response.message_id !== undefined && !messageId) {
                messageId = parsed.v.response.message_id
                this.messageId = parsed.v.response.message_id
              }
              
              const fragments = parsed.v.response.fragments
              if (Array.isArray(fragments) && fragments.length > 0) {
                for (const fragment of fragments) {
                  DeepSeekStreamHandler.collectFragmentMetadata(fragment, searchQueries, relatedSearches)
                  DeepSeekStreamHandler.collectFragmentSearchResults(fragment, searchResults)

                  if (Array.isArray(fragment.results)) {
                    DeepSeekStreamHandler.mergeSearchResultsInto(searchResults, fragment.results)
                  }
                  DeepSeekStreamHandler.collectFragmentSearchResults(fragment, searchResults)

                  if (fragment.content) {
                    let cleanedFragment = fragment.content.replace(/FINISHED/g, '')
                    cleanedFragment = stripSearchControlMarker(cleanedFragment, shouldStripSearchControlMarker)
                    cleanedFragment = formatInlineCitationMarkers(
                      cleanedFragment,
                      shouldProcessInlineCitationMarkers,
                      shouldPreserveInlineCitationMarkers
                    )
                    if (fragment.type === 'THINK') {
                      accumulatedThinkingContent += cleanedFragment
                    } else if (fragment.type === 'ANSWER' || fragment.type === 'RESPONSE') {
                      accumulatedContent += cleanedFragment
                    }
                  }
                }
              }
            } else if (parsed.p === 'response/fragments') {
              if (Array.isArray(parsed.v)) {
                for (const fragment of parsed.v) {
                  DeepSeekStreamHandler.collectFragmentMetadata(fragment, searchQueries, relatedSearches)
                  DeepSeekStreamHandler.collectFragmentSearchResults(fragment, searchResults)

                  if (fragment.content) {
                    let cleanedFragment = fragment.content.replace(/FINISHED/g, '')
                    cleanedFragment = stripSearchControlMarker(cleanedFragment, shouldStripSearchControlMarker)
                    cleanedFragment = formatInlineCitationMarkers(
                      cleanedFragment,
                      shouldProcessInlineCitationMarkers,
                      shouldPreserveInlineCitationMarkers
                    )
                    if (fragment.type === 'THINK') {
                      currentPath = 'thinking'
                      accumulatedThinkingContent += cleanedFragment
                    } else if (fragment.type === 'ANSWER' || fragment.type === 'RESPONSE') {
                      currentPath = 'content'
                      accumulatedContent += cleanedFragment
                    }
                  }
                }
              }
            } else if (parsed.p === 'response' && Array.isArray(parsed.v)) {
              const hasThinking = parsed.v.some((e: any) => 
                e.p === 'response' && e.v && typeof e.v === 'object' && e.v.thinking_enabled === true
              )
              if (hasThinking) {
                currentPath = 'thinking'
              }
            }

            if (
              (parsed.p === 'response/search_results' || /^response\/fragments\/-?\d+\/results$/.test(parsed.p || ''))
              && Array.isArray(parsed.v)
            ) {
              if (parsed.o !== 'BATCH') {
                DeepSeekStreamHandler.mergeSearchResultsInto(searchResults, parsed.v)
              } else {
                DeepSeekStreamHandler.applySearchResultBatch(searchResults, parsed.v)
              }
              continue
            }

            // For thinking models, default to 'thinking' path if not set
            if (!currentPath && isThinkingModel) {
              currentPath = 'thinking'
            }
            
            // For fold models (web search only), default to 'content' path if not set
            if (!currentPath && isFoldModel) {
              currentPath = 'content'
            }

            if (typeof parsed.v === 'object' && Array.isArray(parsed.v)) {
              parsed.v.forEach((e: any) => {
                if (e.accumulated_token_usage && typeof e.v === 'number') {
                  accumulatedTokenUsage = e.v
                }
                if (Array.isArray(e.v)) {
                  let cleanedValue = e.v.map((v: any) => v.content).join('').replace(/FINISHED/g, '')
                  cleanedValue = stripSearchControlMarker(cleanedValue, shouldStripSearchControlMarker)
                  cleanedValue = formatInlineCitationMarkers(
                    cleanedValue,
                    shouldProcessInlineCitationMarkers,
                    shouldPreserveInlineCitationMarkers
                  )
                  if (currentPath === 'thinking') {
                    accumulatedThinkingContent += cleanedValue
                  } else if (currentPath === 'content') {
                    accumulatedContent += cleanedValue
                  }
                }
              })
            }

            if (typeof parsed.v === 'string') {
              let cleanedValue = parsed.v.replace(/FINISHED/g, '')
              cleanedValue = stripSearchControlMarker(cleanedValue, shouldStripSearchControlMarker)
              cleanedValue = formatInlineCitationMarkers(
                cleanedValue,
                shouldProcessInlineCitationMarkers,
                shouldPreserveInlineCitationMarkers
              )
              if (currentPath === 'thinking') {
                accumulatedThinkingContent += cleanedValue
              } else if (currentPath === 'content') {
                accumulatedContent += cleanedValue
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      })

      stream.on('end', async () => {
        // Parse tool calls from accumulated content
        const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
          ? { content: accumulatedContent, toolCalls: [] }
          : parseToolCallsFromText(accumulatedContent)
        const citations = isSearchSilentModel
          ? []
          : DeepSeekStreamHandler.createCitationList(searchResults)
        const trimmedContent = cleanContent.trim()

        const message: any = {
          role: 'assistant',
          reasoning_content: accumulatedThinkingContent.trim() || undefined,
          content: toolCalls.length > 0 ? null : trimmedContent,
        }

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        if (citations.length > 0) {
          message.citations = citations
        }

        if (searchQueries.length > 0) {
          message.search_queries = searchQueries
        }

        if (relatedSearches.length > 0) {
          message.related_searches = relatedSearches
        }

        // Log for debugging
        if (isThinkingModel || accumulatedThinkingContent) {
          console.log('[DeepSeek] Non-stream thinking model:', this.model)
          console.log('[DeepSeek] Accumulated thinking content length:', accumulatedThinkingContent.length)
          console.log('[DeepSeek] Accumulated content length:', accumulatedContent.length)
        }

        await this.attachShareInfo()

        const result: any = {
          id: `${this.sessionId}@${messageId ?? ''}`,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: accumulatedTokenUsage },
          created: this.created,
          chat2api: this.shareInfo,
        }

        if (this.debugRaw) {
          result.chat2api_debug = {
            raw_upstream_events: this.rawUpstreamEvents,
          }
        }

        this.appendRawUpstreamTrace('non_stream', toolCalls.length > 0 ? 'tool_calls' : 'stop')
        resolve(result)
      })

      stream.on('error', reject)
    })
  }
}
