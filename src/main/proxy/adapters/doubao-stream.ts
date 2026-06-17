/**
 * Doubao SSE stream handler.
 * Converts Doubao browser SSE events into OpenAI-compatible chat completions.
 */

import { PassThrough } from 'stream'
import type { DoubaoResponseMetadata } from './doubao'

const REASONING_KEY_PATTERN = /(think|reason|deep|cot|chain)/i
const SOURCE_CONTAINER_KEY_PATTERN = /(citation|source|reference|search|web|result|text_tags?|网页|引用|来源|信源|doc|card|site|page)/i
const RELATED_SEARCH_KEY_PATTERN = /(related[_-]?search|related[_-]?question|related|suggest|suggested|suggestted|suggestion|sp_v2|follow[_-]?up|recommend|candidate|question[_-]?list|wcb_item|send[_-]?content)/i
const SEARCH_KEYWORD_KEY_PATTERN = /(keyword|keywords|query|queries|search[_-]?(?:query|queries|word|words|keyword|keywords)|query[_-]?list|search[_-]?infos?)/i
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
  private sessionMeta: DoubaoSessionMeta = {}
  private suggestions: any[] = []
  private citations: DoubaoCitation[] = []
  private citationKeys = new Set<string>()
  private userMessageIds = new Set<string>()
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
      case 'CHAT2API_METADATA':
        this.applyInitialMetadata(event.data)
        return
      case 'SSE_HEARTBEAT':
        return
      case 'FULL_MSG_NOTIFY':
        this.processFullMsg(event.data, transStream)
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
    for (const item of Array.isArray(data?.query_list) ? data.query_list : []) {
      if (item?.question_id) this.userMessageIds.add(String(item.question_id))
      if (item?.local_message_id) this.userMessageIds.add(String(item.local_message_id))
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
        this.appendReasoningText(text, transStream)
        continue
      }

      if (block?.block_type === 10000) {
        this.appendText(text, transStream)
      }
    }
  }

  private processFullMsg(data: any, transStream?: PassThrough): void {
    const message = data?.message || data
    if (!message || typeof message !== 'object') return

    if (this.isKnownUserMessage(message) || this.isLikelyUserMessage(message)) return

    const meta = message.meta || data?.meta || {}
    if (message.message_id) {
      this.sessionMeta.messageId = message.message_id
    }
    if (message.section_id || meta.section_id) {
      this.sessionMeta.sectionId = message.section_id || meta.section_id
    }
    if (typeof message.index_in_conv === 'number' || typeof meta.index_in_conv === 'number') {
      this.sessionMeta.lastMessageIndex = message.index_in_conv ?? meta.index_in_conv
    }

    const blocks = message?.content?.content_block || message?.content_block || data?.content?.content_block
    if (!Array.isArray(blocks)) return

    for (const block of blocks) {
      const text = this.extractBlockText(block)
      if (!text) continue

      if (this.isReasoningBlock(block)) {
        this.appendReasoningText(text, transStream)
      } else if (block?.block_type === 10000 || this.isAssistantTextBlock(block)) {
        this.appendText(text, transStream)
      }
    }
  }

  private processChunkDelta(data: any, transStream?: PassThrough): void {
    const directReasoning = this.extractDirectReasoningText(data)
    if (directReasoning) {
      this.appendReasoningText(directReasoning, transStream)
    }

    const text = typeof data?.text === 'string' ? data.text : ''
    if (!text) return

    if (text === directReasoning) {
      return
    }

    if (this.hasReasoningMarker(data)) {
      this.appendReasoningText(text, transStream)
    } else {
      this.appendText(text, transStream)
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
            this.appendReasoningText(text, transStream)
          } else if (blockType === 10000) {
            this.appendText(text, transStream)
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
              this.appendReasoningText(text, transStream)
            } else {
              this.appendText(text, transStream)
            }
          } catch {
            if (this.isReasoningPayload(patchValue)) {
              this.appendReasoningText(content, transStream)
            } else {
              this.appendText(content, transStream)
            }
          }
        } else if (content && typeof content === 'object') {
          const text = content.text || ''
          if (this.isReasoningPayload(patchValue) || this.isReasoningPayload(content)) {
            this.appendReasoningText(text, transStream)
          } else {
            this.appendText(text, transStream)
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

  private appendText(text: string, transStream?: PassThrough): void {
    const delta = this.createAppendDelta(this.content, text)
    if (!delta) return

    this.content += delta
    if (transStream) {
      transStream.write(this.createChunk({ content: delta }))
    }
  }

  private appendReasoningText(text: string, transStream?: PassThrough): void {
    const delta = this.createAppendDelta(this.reasoning, text)
    if (!delta) return

    this.reasoning += delta
    if (transStream) {
      transStream.write(this.createChunk({ reasoning_content: delta }))
    }
  }

  private createAppendDelta(existing: string, incoming: string): string {
    if (!incoming) return ''
    if (!existing) return incoming
    if (incoming.startsWith(existing)) return incoming.slice(existing.length)
    if (existing.endsWith(incoming)) return ''

    const maxOverlap = Math.min(existing.length, incoming.length, 4000)
    for (let size = maxOverlap; size > 0; size--) {
      if (existing.endsWith(incoming.slice(0, size))) {
        return incoming.slice(size)
      }
    }

    return incoming
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
    if (block.block_type === 10000 || block.block_type === 2074) {
      return this.isReasoningPayload(block)
    }
    if (block.block_type === 10101) {
      return true
    }
    return this.isReasoningPayload(block)
  }

  private isLikelyUserMessage(message: any): boolean {
    const role = this.pickString(message.role, message.sender_role, message.message_role, message.sender?.role)
    if (/user|human/i.test(role)) return true
    if (/assistant|bot|answer/i.test(role)) return false

    const messageType = this.pickString(message.message_type, message.type, message.sender_type)
    if (/user|human/i.test(messageType)) return true
    if (/assistant|bot|answer/i.test(messageType)) return false

    return false
  }

  private isKnownUserMessage(message: any): boolean {
    const ids = [
      message.message_id,
      message.local_message_id,
      message.id,
      message.meta?.message_id,
      message.meta?.local_message_id,
    ]
    return ids.some(id => id && this.userMessageIds.has(String(id)))
  }

  private isAssistantTextBlock(block: any): boolean {
    if (!block || typeof block !== 'object') return false
    const blockType = this.pickString(block.type, block.name, block.block_name)
    return /answer|assistant|text/i.test(blockType)
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
    this.collectDoubaoSearchBlocks(value)
    this.collectRelatedSearches(value)
    this.collectSources(value)
    this.collectSearchKeywords(value)
  }

  private collectDoubaoSearchBlocks(value: any, depth: number = 0): void {
    if (!value || depth > 10) return

    if (typeof value === 'string') {
      const parsed = this.tryParseJSON(value)
      if (parsed) {
        this.collectDoubaoSearchBlocks(parsed, depth + 1)
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectDoubaoSearchBlocks(item, depth + 1)
      }
      return
    }

    if (typeof value !== 'object') return

    const searchBlock = value.search_query_result_block || value.searchQueryResultBlock
    if (searchBlock && typeof searchBlock === 'object') {
      this.collectSearchQueryResultBlock(searchBlock)
    }

    for (const child of Object.values(value)) {
      this.collectDoubaoSearchBlocks(child, depth + 1)
    }
  }

  private collectSearchQueryResultBlock(block: any): void {
    const queries = block?.queries || block?.query_list || block?.queryList
    if (Array.isArray(queries)) {
      for (const query of queries) {
        this.addSearchKeyword(this.pickString(query?.query, query?.keyword, query?.text, query))
      }
    }

    const results = block?.results || block?.result_list || block?.resultList
    if (!Array.isArray(results)) return

    for (const result of results) {
      const card = result?.text_card || result?.textCard || result?.card || result
      this.addCitationFromObject(card)
    }
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
        || value.send_content
        || value.sendContent
        || value.display_text
        || value.displayText
        || value.send_message_text
        || value.sendMessageText
        || value?.text_conf?.send_message_text
        || value?.text_conf?.display_text
        || value?.textConf?.sendMessageText
        || value?.textConf?.displayText
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
      value.pageUrl,
      value.display_url,
      value.displayUrl,
      value.source?.url,
      value.page?.url,
      value.doc?.url
    )

    const title = this.pickString(
      value.title,
      value.name,
      value.site_name,
      value.siteName,
      value.source_name,
      value.sourceName,
      value.display_title,
      value.displayTitle,
      value.text,
      value.source?.title,
      value.page?.title,
      value.doc?.title
    ) || url

    const fallbackUrl = url || this.createCitationFallbackUrl(value, title)
    if (!fallbackUrl || IMAGE_OR_STATIC_URL_PATTERN.test(fallbackUrl)) return

    const snippet = this.pickString(value.snippet, value.summary, value.description, value.content, value.abstract, value.quote, value.fragment)
    const siteName = this.pickString(value.site_name, value.siteName, value.sitename, value.source_name, value.sourceName, value.domain, value.website, value.host)
    const explicitIndex = this.pickNumber(value.index, value.cite_index, value.citeIndex, value.ref_num, value.ref, value.source_index, value.sourceIndex, value.original_doc_rank)
    const citationKey = [
      explicitIndex ?? '',
      fallbackUrl,
      title,
      snippet,
    ].join('\u0000')
    if (this.citationKeys.has(citationKey)) return
    this.citationKeys.add(citationKey)

    this.citations.push({
      index: explicitIndex ?? this.citations.length + 1,
      title,
      url: fallbackUrl,
      ...(snippet ? { snippet } : {}),
      ...(siteName ? { site_name: siteName } : {}),
    })
  }

  private createCitationFallbackUrl(value: any, title: string): string {
    const displayUrl = this.pickString(value?.url, value?.display_url, value?.displayUrl)
    if (displayUrl && !IMAGE_OR_STATIC_URL_PATTERN.test(displayUrl)) {
      return displayUrl
    }

    const docId = this.pickString(value?.doc_id, value?.docId, value?.id)
    if (docId && title) {
      return `doubao-search:${encodeURIComponent(docId)}`
    }

    return ''
  }

  private collectSearchKeyword(value: any): void {
    this.addSearchKeyword(this.pickString(value.keyword, value.query, value.search_query, value.searchQuery))
  }

  private collectSearchKeywords(value: any, keyHint: string = '', depth: number = 0): void {
    if (!value || depth > 8) return

    const inKeywordContext = SEARCH_KEYWORD_KEY_PATTERN.test(keyHint)
    if (typeof value === 'string') {
      const parsed = this.tryParseJSON(value)
      if (parsed) {
        this.collectSearchKeywords(parsed, keyHint, depth + 1)
      } else if (inKeywordContext) {
        this.addSearchKeyword(value)
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectSearchKeywords(item, keyHint, depth + 1)
      }
      return
    }

    if (typeof value !== 'object') return

    for (const [key, child] of Object.entries(value)) {
      this.collectSearchKeywords(child, SEARCH_KEYWORD_KEY_PATTERN.test(key) ? key : keyHint, depth + 1)
    }
  }

  private addSearchKeyword(keyword: string): void {
    const trimmed = keyword.trim()
    if (
      trimmed
      && !/^https?:\/\//i.test(trimmed)
      && !/^搜索\s*\d+\s*个?关键词.*参考\s*\d+\s*篇?资料/.test(trimmed)
      && !/^\d+$/.test(trimmed)
      && !/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(trimmed)
      && !(/^[A-Za-z0-9_-]{8,}$/.test(trimmed) && !/[\s\u3400-\u9fff]/.test(trimmed))
      && !this.searchKeywords.includes(trimmed)
    ) {
      this.searchKeywords.push(trimmed)
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

  private pickNumber(...values: any[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() && /^\d+$/.test(value.trim())) {
        return Number(value.trim())
      }
    }
    return undefined
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
