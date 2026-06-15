/**
 * Doubao SSE stream handler.
 * Converts Doubao browser SSE events into OpenAI-compatible chat completions.
 */

import { PassThrough } from 'stream'
import type { DoubaoResponseMetadata } from './doubao'

type DoubaoTextSource = 'chunk_delta' | 'stream_chunk'

const REASONING_KEY_PATTERN = /(think|reason|deep|cot|chain)/i
const SOURCE_CONTAINER_KEY_PATTERN = /(citation|source|reference|search|web|result|text_tags?|网页|引用|来源|信源)/i
const RELATED_SEARCH_KEY_PATTERN = /(related[_-]?search|related[_-]?question|suggest|sp_v2|follow[_-]?up)/i
const IMAGE_OR_STATIC_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|heic|svg)(?:[?#]|$)|byteimg\.com|imagex-sign/i

interface ParsedSSEEvent {
  event: string
  id?: string
  data: any
}

interface DoubaoSessionMeta {
  conversationId?: string
  localConversationId?: string
  sectionId?: string
  messageId?: string
  lastMessageIndex?: number
}

interface DoubaoCitation {
  index: number
  title: string
  url: string
  snippet?: string
  site_name?: string
}

export class DoubaoStreamHandler {
  private model: string
  private sessionId: string
  private created: number
  private onEnd?: () => void
  private content: string = ''
  private reasoning: string = ''
  private textSource: DoubaoTextSource | null = null
  private reasoningTextSource: DoubaoTextSource | null = null
  private sessionMeta: DoubaoSessionMeta = {}
  private suggestions: any[] = []
  private citations: DoubaoCitation[] = []
  private searchKeywords: string[] = []
  private brief: string = ''
  private imageUrls: string[] = []
  private shareUrl: string = ''
  private shareId: string = ''
  private shareError: string = ''
  private conversationUrl: string = ''
  private done = false

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    initialMetadata?: DoubaoResponseMetadata
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.applyInitialMetadata(initialMetadata)
  }

  getSessionMeta(): DoubaoSessionMeta {
    return this.sessionMeta
  }

  getAssistantContent(): string {
    return this.content
  }

  private applyInitialMetadata(metadata?: DoubaoResponseMetadata): void {
    if (!metadata) return

    if (metadata.conversation_id) {
      this.sessionMeta.conversationId = metadata.conversation_id
    }
    if (metadata.local_conversation_id) {
      this.sessionMeta.localConversationId = metadata.local_conversation_id
    }
    if (metadata.section_id) {
      this.sessionMeta.sectionId = metadata.section_id
    }
    if (metadata.message_id) {
      this.sessionMeta.messageId = metadata.message_id
    }
    if (metadata.conversation_url) {
      this.conversationUrl = metadata.conversation_url
    }
    if (metadata.share_url) {
      this.shareUrl = metadata.share_url
    }
    if (metadata.share_id) {
      this.shareId = metadata.share_id
    }
    if (metadata.share_error) {
      this.shareError = metadata.share_error
    }
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    let buffer = ''

    transStream.write(this.createChunk({ role: 'assistant', content: '' }))

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const { blocks, rest } = this.takeCompleteEventBlocks(buffer)
      buffer = rest

      for (const block of blocks) {
        const event = this.parseEventBlock(block)
        if (!event) continue
        this.processEvent(event, transStream)
      }
    })

    stream.on('end', () => {
      const lastEvent = this.parseEventBlock(buffer)
      if (lastEvent) {
        this.processEvent(lastEvent, transStream)
      }
      this.finishStream(transStream)
    })

    stream.on('error', (error) => {
      transStream.emit('error', error)
    })

    return transStream
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let buffer = ''

    for await (const chunk of stream as any) {
      buffer += chunk.toString()
      const { blocks, rest } = this.takeCompleteEventBlocks(buffer)
      buffer = rest

      for (const block of blocks) {
        const event = this.parseEventBlock(block)
        if (!event) continue
        this.processEvent(event)
      }
    }

    const lastEvent = this.parseEventBlock(buffer)
    if (lastEvent) {
      this.processEvent(lastEvent)
    }

    const message: any = {
      role: 'assistant',
      content: this.content.trim(),
    }

    if (this.reasoning.trim()) {
      message.reasoning_content = this.reasoning.trim()
    }
    Object.assign(message, this.createMessageMetadata())

    if (this.imageUrls.length > 0) {
      message.images = this.imageUrls
    }

    const metadata = this.createFinalMetadataChunk()

    return {
      id: this.sessionMeta.conversationId || this.sessionId,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      ...metadata,
      choices: [
        {
          index: 0,
          message,
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }

  private takeCompleteEventBlocks(buffer: string): { blocks: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, '\n')
    const parts = normalized.split(/\n\n+/)

    if (!normalized.match(/\n\n+$/)) {
      const rest = parts.pop() || ''
      return { blocks: parts, rest }
    }

    return { blocks: parts.filter(Boolean), rest: '' }
  }

  private parseEventBlock(block: string): ParsedSSEEvent | null {
    const trimmedBlock = block.trim()
    if (!trimmedBlock) return null

    let event = ''
    let id = ''
    const dataLines: string[] = []

    for (const rawLine of trimmedBlock.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
    }

    if (!event && dataLines.length === 0) return null

    const dataText = dataLines.join('\n')
    let data: any = {}
    if (dataText && dataText !== '[DONE]') {
      try {
        data = JSON.parse(dataText)
      } catch {
        data = dataText
      }
    }

    return { event, id, data }
  }

  private processEvent(event: ParsedSSEEvent, transStream?: PassThrough): void {
    this.collectMetadata(event.data)

    switch (event.event) {
      case 'SSE_HEARTBEAT':
      case 'FULL_MSG_NOTIFY':
        return
      case 'SSE_ACK':
        this.processAck(event.data)
        return
      case 'STREAM_MSG_NOTIFY':
        this.processStreamMsg(event.data, transStream)
        return
      case 'CHUNK_DELTA':
        this.processChunkDelta(event.data, transStream)
        return
      case 'STREAM_CHUNK':
        this.processStreamChunk(event.data, transStream)
        return
      case 'SSE_REPLY_END':
        this.processReplyEnd(event.data)
        if (transStream) {
          this.finishStream(transStream)
        }
        return
      case 'STREAM_ERROR': {
        const errorMessage = formatDoubaoStreamError(event.data)
        if (transStream) {
          transStream.emit('error', new Error(errorMessage))
        }
      }
    }
  }

  private processAck(data: any): void {
    const meta = data?.ack_client_meta || {}
    if (meta.conversation_id && meta.conversation_id !== '0') {
      this.sessionMeta.conversationId = meta.conversation_id
      this.conversationUrl = `https://www.doubao.com/chat/${encodeURIComponent(meta.conversation_id)}`
    }
    if (meta.local_conversation_id) {
      this.sessionMeta.localConversationId = meta.local_conversation_id
    }
    if (meta.section_id) {
      this.sessionMeta.sectionId = meta.section_id
    }

    const query = Array.isArray(data?.query_list) ? data.query_list[0] : undefined
    if (typeof query?.message_index === 'number') {
      this.sessionMeta.lastMessageIndex = query.message_index
    }
  }

  private processStreamMsg(data: any, transStream?: PassThrough): void {
    const meta = data?.meta || {}
    if (meta.message_id) {
      this.sessionMeta.messageId = meta.message_id
    }
    if (meta.section_id) {
      this.sessionMeta.sectionId = meta.section_id
    }
    if (typeof meta.index_in_conv === 'number') {
      this.sessionMeta.lastMessageIndex = meta.index_in_conv
    }

    const blocks = data?.content?.content_block
    if (!Array.isArray(blocks)) return

    for (const block of blocks) {
      const text = this.extractBlockText(block)
      if (!text) continue

      if (this.isReasoningBlock(block)) {
        this.appendReasoningText(text, undefined, transStream)
        continue
      }

      if (block?.block_type === 10000) {
        this.content += text
        if (transStream) {
          transStream.write(this.createChunk({ content: text }))
        }
        break
      }
    }
  }

  private processChunkDelta(data: any, transStream?: PassThrough): void {
    const directReasoning = this.extractDirectReasoningText(data)
    if (directReasoning) {
      this.appendReasoningText(directReasoning, 'chunk_delta', transStream)
    }

    const text = typeof data?.text === 'string' ? data.text : ''
    if (!text) return

    if (text === directReasoning) {
      return
    }

    if (this.hasReasoningMarker(data)) {
      this.appendReasoningText(text, 'chunk_delta', transStream)
    } else {
      this.appendText(text, 'chunk_delta', transStream)
    }
  }

  private processStreamChunk(data: any, transStream?: PassThrough): void {
    const patchOps = data?.patch_op
    if (!Array.isArray(patchOps)) return

    for (const op of patchOps) {
      const patchObject = op?.patch_object
      const patchValue = op?.patch_value || {}

      if (patchObject === 1) {
        const blocks = patchValue.content_block
        if (!Array.isArray(blocks)) continue
        for (const block of blocks) {
          const blockType = block?.block_type
          if (blockType === 2074) {
            this.extractImageUrls(block)
            continue
          }

          const text = this.extractBlockText(block)
          if (!text) continue

          if (this.isReasoningBlock(block)) {
            this.appendReasoningText(text, 'stream_chunk', transStream)
          } else if (blockType === 10000) {
            this.appendText(text, 'stream_chunk', transStream)
          }
        }
      } else if (patchObject === 3) {
        const brief = patchValue?.msg_finish_attr?.brief
        if (brief && !this.brief) {
          this.brief = brief
        }
      } else if (patchObject === 50) {
        this.extractSuggestions(patchValue?.ext)
      } else if (patchObject === 102) {
        const content = patchValue?.content
        if (typeof content === 'string' && content) {
          try {
            const parsed = JSON.parse(content)
            const text = parsed?.text || ''
            if (this.isReasoningPayload(patchValue) || this.isReasoningPayload(parsed)) {
              this.appendReasoningText(text, 'stream_chunk', transStream)
            } else {
              this.appendText(text, 'stream_chunk', transStream)
            }
          } catch {
            if (this.isReasoningPayload(patchValue)) {
              this.appendReasoningText(content, 'stream_chunk', transStream)
            } else {
              this.appendText(content, 'stream_chunk', transStream)
            }
          }
        } else if (content && typeof content === 'object') {
          const text = content.text || ''
          if (this.isReasoningPayload(patchValue) || this.isReasoningPayload(content)) {
            this.appendReasoningText(text, 'stream_chunk', transStream)
          } else {
            this.appendText(text, 'stream_chunk', transStream)
          }
        }
      }
    }
  }

  private processReplyEnd(data: any): void {
    const brief = data?.msg_finish_attr?.brief
    if (brief && !this.brief) {
      this.brief = brief
    }
  }

  private appendText(text: string, source: DoubaoTextSource, transStream?: PassThrough): void {
    if (!text) return

    if (this.textSource === null) {
      this.textSource = source
    } else if (this.textSource !== source) {
      return
    }

    this.content += text
    if (transStream) {
      transStream.write(this.createChunk({ content: text }))
    }
  }

  private appendReasoningText(text: string, source?: DoubaoTextSource, transStream?: PassThrough): void {
    if (!text) return

    if (source) {
      if (this.reasoningTextSource === null) {
        this.reasoningTextSource = source
      } else if (this.reasoningTextSource !== source) {
        return
      }
    }

    this.reasoning += text
    if (transStream) {
      transStream.write(this.createChunk({ reasoning_content: text }))
    }
  }

  private extractDirectReasoningText(data: any): string {
    if (!data || typeof data !== 'object') return ''
    for (const key of [
      'reasoning_content',
      'reasoningContent',
      'reasoning_text',
      'thinking_content',
      'thinkingContent',
      'thinking_text',
      'deep_think',
      'deepThink',
    ]) {
      if (typeof data[key] === 'string' && data[key]) {
        return data[key]
      }
    }
    return ''
  }

  private isReasoningBlock(block: any): boolean {
    if (!block || typeof block !== 'object') return false
    if (block.block_type === 10000 || block.block_type === 10101 || block.block_type === 2074) {
      return this.isReasoningPayload(block)
    }
    return this.extractBlockText(block) !== ''
  }

  private isReasoningPayload(value: any): boolean {
    if (!value || typeof value !== 'object') return false

    const stack: any[] = [value]
    let depth = 0
    while (stack.length > 0 && depth < 80) {
      depth++
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue

      for (const [key, child] of Object.entries(current)) {
        if (REASONING_KEY_PATTERN.test(key)) {
          return true
        }
        if (
          ['type', 'name', 'path', 'field', 'patch_path', 'block_name', 'event'].includes(key)
          && typeof child === 'string'
          && REASONING_KEY_PATTERN.test(child)
        ) {
          return true
        }
        if (child && typeof child === 'object') {
          stack.push(child)
        }
      }
    }

    return false
  }

  private hasReasoningMarker(value: any): boolean {
    if (!value || typeof value !== 'object') return false

    for (const key of ['type', 'name', 'path', 'field', 'patch_path', 'block_name', 'event', 'mode']) {
      const marker = value[key]
      if (typeof marker === 'string' && REASONING_KEY_PATTERN.test(marker)) {
        return true
      }
    }

    return false
  }

  private extractBlockText(block: any): string {
    if (!block || typeof block !== 'object') return ''
    const content = block.content || {}
    return content?.text_block?.text
      || content?.thinking_block?.text
      || content?.reasoning_block?.text
      || content?.deep_think_block?.text
      || content?.process_block?.text
      || block.text
      || this.extractTextFromUnknown(content)
      || ''
  }

  private extractTextFromUnknown(value: any, depth: number = 0): string {
    if (!value || depth > 4) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      return value.map(item => this.extractTextFromUnknown(item, depth + 1)).filter(Boolean).join('')
    }
    if (typeof value !== 'object') return ''

    for (const key of ['text', 'content', 'markdown', 'summary', 'description']) {
      if (typeof value[key] === 'string' && value[key]) {
        return value[key]
      }
    }

    for (const child of Object.values(value)) {
      const text = this.extractTextFromUnknown(child, depth + 1)
      if (text) return text
    }

    return ''
  }

  private extractSuggestions(ext: any): void {
    const rawSuggestions = ext?.sp_v2
    if (!rawSuggestions) return

    try {
      const parsed = JSON.parse(rawSuggestions)
      if (Array.isArray(parsed)) {
        for (const suggestion of parsed) {
          this.addRelatedSearch(suggestion)
        }
      }
    } catch {
      // Suggestions are optional.
    }
  }

  private extractImageUrls(block: any): void {
    const creations = block?.content?.creation_block?.creations
    if (!Array.isArray(creations)) return

    for (const creation of creations) {
      const image = creation?.image || {}
      const url = image?.image_ori_raw?.url || image?.image_ori?.url || image?.image_url
      if (url && !this.imageUrls.includes(url)) {
        this.imageUrls.push(url)
      }
    }
  }

  private collectMetadata(value: any): void {
    this.collectRelatedSearches(value)
    this.collectSources(value)
  }

  private collectRelatedSearches(value: any, keyHint: string = '', depth: number = 0): void {
    if (!value || depth > 8) return

    if (typeof value === 'string') {
      if (!RELATED_SEARCH_KEY_PATTERN.test(keyHint)) return
      const parsed = this.tryParseJSON(value)
      if (parsed) {
        this.collectRelatedSearches(parsed, keyHint, depth + 1)
      } else {
        this.addRelatedSearch(value)
      }
      return
    }

    if (Array.isArray(value)) {
      if (RELATED_SEARCH_KEY_PATTERN.test(keyHint)) {
        for (const item of value) {
          this.addRelatedSearch(item)
        }
        return
      }
      for (const item of value) {
        this.collectRelatedSearches(item, keyHint, depth + 1)
      }
      return
    }

    if (typeof value !== 'object') return

    for (const [key, child] of Object.entries(value)) {
      const nextHint = RELATED_SEARCH_KEY_PATTERN.test(key) ? key : keyHint
      this.collectRelatedSearches(child, nextHint, depth + 1)
    }
  }

  private addRelatedSearch(value: any): void {
    if (value === undefined || value === null) return

    let item = value
    if (typeof value === 'object') {
      item = value.text
        || value.query
        || value.question
        || value.title
        || value.display_text
        || value.displayText
        || value.send_message_text
        || value
    }

    const key = typeof item === 'string'
      ? item.trim()
      : JSON.stringify(item)
    if (!key || this.suggestions.some(existing => {
      const existingKey = typeof existing === 'string' ? existing.trim() : JSON.stringify(existing)
      return existingKey === key
    })) {
      return
    }

    this.suggestions.push(item)
  }

  private collectSources(value: any, keyHint: string = '', sourceContext: boolean = false, depth: number = 0): void {
    if (!value || depth > 10) return

    if (typeof value === 'string') {
      const parsed = this.tryParseJSON(value)
      if (parsed) {
        this.collectSources(parsed, keyHint, sourceContext, depth + 1)
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectSources(item, keyHint, sourceContext, depth + 1)
      }
      return
    }

    if (typeof value !== 'object') return

    const inSourceContext = sourceContext || SOURCE_CONTAINER_KEY_PATTERN.test(keyHint)
    if (inSourceContext) {
      this.addCitationFromObject(value)
      this.collectSearchKeyword(value)
    }

    for (const [key, child] of Object.entries(value)) {
      const nextSourceContext = inSourceContext || SOURCE_CONTAINER_KEY_PATTERN.test(key)
      this.collectSources(child, key, nextSourceContext, depth + 1)
    }
  }

  private addCitationFromObject(value: any): void {
    if (!value || typeof value !== 'object') return

    const url = this.pickUrl(
      value.url,
      value.href,
      value.link,
      value.source_url,
      value.sourceUrl,
      value.site_url,
      value.siteUrl,
      value.web_url,
      value.webUrl,
      value.page_url,
      value.pageUrl
    )
    if (!url || IMAGE_OR_STATIC_URL_PATTERN.test(url)) return
    if (this.citations.some(item => item.url === url)) return

    const title = this.pickString(
      value.title,
      value.name,
      value.site_name,
      value.siteName,
      value.source_name,
      value.sourceName,
      value.display_title,
      value.displayTitle,
      value.text
    ) || url
    const snippet = this.pickString(value.snippet, value.summary, value.description, value.content, value.abstract)
    const siteName = this.pickString(value.site_name, value.siteName, value.source_name, value.sourceName, value.domain)

    this.citations.push({
      index: this.citations.length + 1,
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(siteName ? { site_name: siteName } : {}),
    })
  }

  private collectSearchKeyword(value: any): void {
    const keyword = this.pickString(value.keyword, value.query, value.search_query, value.searchQuery)
    if (keyword && !this.searchKeywords.includes(keyword)) {
      this.searchKeywords.push(keyword)
    }
  }

  private createCitationList(): DoubaoCitation[] {
    return [...this.citations].sort((a, b) => a.index - b.index)
  }

  private createSearchSummary(): any[] | { keywords: string[]; webPages: DoubaoCitation[] } | string {
    const webPages = this.createCitationList()
    if (this.searchKeywords.length === 0 && webPages.length === 0) {
      return ''
    }

    return {
      keywords: [...this.searchKeywords],
      webPages,
    }
  }

  private createRelatedSearches(): any[] | string {
    return this.suggestions.length > 0 ? [...this.suggestions] : ''
  }

  private createMessageMetadata(): Record<string, any> {
    const citations = this.createCitationList()
    const citationValue = citations.length > 0 ? citations : ''

    return {
      citations: citationValue,
      source_list: citationValue,
      search_results: this.createSearchSummary(),
      related_searches: this.createRelatedSearches(),
    }
  }

  private createChat2ApiInfo(): Record<string, any> {
    const citations = this.createCitationList()
    const citationValue = citations.length > 0 ? citations : ''

    return {
      provider: 'doubao',
      session_id: this.sessionId,
      conversation_id: this.sessionMeta.conversationId || '',
      local_conversation_id: this.sessionMeta.localConversationId || '',
      section_id: this.sessionMeta.sectionId || '',
      message_id: this.sessionMeta.messageId || '',
      conversation_url: this.conversationUrl || '',
      share_url: this.shareUrl || '',
      share_id: this.shareId || '',
      citations: citationValue,
      source_list: citationValue,
      search_results: this.createSearchSummary(),
      related_searches: this.createRelatedSearches(),
      ...(this.shareError ? { share_error: this.shareError } : {}),
    }
  }

  private createFinalMetadataChunk(): Record<string, any> {
    return {
      ...this.createMessageMetadata(),
      share_url: this.shareUrl || '',
      chat2api: this.createChat2ApiInfo(),
    }
  }

  private tryParseJSON(value: string): any {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }

  private pickString(...values: any[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return ''
  }

  private pickUrl(...values: any[]): string {
    for (const value of values) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (/^https?:\/\//i.test(trimmed)) {
        return trimmed
      }
    }
    return ''
  }

  private finishStream(transStream: PassThrough): void {
    if (this.done) return
    this.done = true

    transStream.write(this.createChunk({}, 'stop', this.createFinalMetadataChunk()))
    transStream.write('data: [DONE]\n\n')
    transStream.end()

    if (this.onEnd) {
      this.onEnd()
    }
  }

  private createChunk(
    delta: { role?: 'assistant'; content?: string; reasoning_content?: string; tool_calls?: any[] },
    finishReason?: string,
    extras?: Record<string, any>
  ): string {
    return `data: ${JSON.stringify({
      id: this.sessionMeta.conversationId || this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason || null,
        },
      ],
      created: this.created,
      ...(extras || {}),
    })}\n\n`
  }
}

function formatDoubaoStreamError(data: any): string {
  const message = data?.error_msg
    || data?.message
    || data?.msg
    || data?.error?.message
    || 'Doubao stream error'

  const code = data?.error_code
    || data?.code
    || data?.status_code
    || data?.error?.code

  const detail = code ? `${message} (code: ${code})` : message
  const raw = JSON.stringify(data || {})
  return raw && raw !== '{}' ? `${detail}; raw=${raw.slice(0, 500)}` : detail
}
