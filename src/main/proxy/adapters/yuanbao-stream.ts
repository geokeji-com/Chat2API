import { PassThrough } from 'stream'
import type { YuanbaoResponseMetadata } from './yuanbao.ts'

interface ParsedEvent { event: string; data: any }

export class YuanbaoStreamHandler {
  private model: string
  private sessionId: string
  private metadataProvider?: (messageId?: string) => Promise<YuanbaoResponseMetadata>
  private onEnd?: () => void | Promise<void>
  private created = Math.floor(Date.now() / 1000)
  private content = ''
  private reasoning = ''
  private messageId = ''
  private metadata?: YuanbaoResponseMetadata

  constructor(
    model: string,
    sessionId: string,
    metadataProvider?: (messageId?: string) => Promise<YuanbaoResponseMetadata>,
    onEnd?: () => void | Promise<void>,
  ) {
    this.model = model
    this.sessionId = sessionId
    this.metadataProvider = metadataProvider
    this.onEnd = onEnd
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const output = new PassThrough()
    let buffer = ''
    output.write(this.createChunk({ role: 'assistant', content: '' }))

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const parts = buffer.replace(/\r\n/g, '\n').split(/\n\n+/)
      buffer = parts.pop() || ''
      for (const part of parts) this.processEvent(this.parseEvent(part), output)
    })
    stream.on('end', async () => {
      this.processEvent(this.parseEvent(buffer), output)
      await this.attachMetadata()
      if (!this.content.trim() && this.metadata?.answer_content) {
        this.content = this.metadata.answer_content
        output.write(this.createChunk({ content: this.metadata.answer_content }))
      }
      output.write(this.createChunk({}, 'stop', this.createFinalMetadata()))
      output.write('data: [DONE]\n\n')
      output.end()
      await this.onEnd?.()
    })
    stream.on('error', error => output.emit('error', error))
    return output
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let buffer = ''
    for await (const chunk of stream as any) buffer += chunk.toString()
    for (const block of buffer.replace(/\r\n/g, '\n').split(/\n\n+/)) this.processEvent(this.parseEvent(block))
    await this.attachMetadata()

    const content = this.content.trim() || this.metadata?.answer_content || ''
    const message: Record<string, any> = { role: 'assistant', content }
    const finalReasoning = this.reasoning.trim() || this.metadata?.reasoning_content || ''
    message.reasoning_content = finalReasoning
    Object.assign(message, this.createMessageMetadata())

    return {
      id: this.sessionId,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      ...this.createFinalMetadata(),
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }

  private parseEvent(block: string): ParsedEvent | null {
    if (!block.trim()) return null
    let event = ''
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return null
    const text = dataLines.join('\n')
    if (text === '[DONE]') return { event, data: text }
    try { return { event, data: JSON.parse(text) } } catch { return { event, data: text } }
  }

  private processEvent(event: ParsedEvent | null, output?: PassThrough): void {
    if (!event || event.data === '[DONE]') return
    const data = event.data
    if (!data || typeof data !== 'object') return
    this.messageId = data.messageId || data.msgId || this.messageId

    if (data.type === 'deepSearch') {
      for (const item of data.contents || []) {
        if (item?.type === 'text' && typeof item.msg === 'string') {
          this.reasoning += item.msg
          output?.write(this.createChunk({ reasoning_content: item.msg }))
        }
      }
      return
    }

    const text = this.extractAnswerText(data)
    if (text) {
      this.content += text
      output?.write(this.createChunk({ content: text }))
    }
  }

  private extractAnswerText(data: any): string {
    if (data.type === 'text') {
      for (const value of [data.msg, data.text, data.content, data.delta]) {
        if (typeof value === 'string') return value
      }
    }
    if (data.type === 'markdown' && typeof data.content === 'string') return data.content
    return ''
  }

  private async attachMetadata(): Promise<void> {
    if (!this.metadataProvider) return
    try { this.metadata = await this.metadataProvider(this.messageId) }
    catch (error) { console.error('[Yuanbao] Failed to attach response metadata:', error) }
  }

  private createMessageMetadata(): Record<string, any> {
    return {
      citations: this.metadata?.citations || '',
      source_list: this.metadata?.source_list || '',
      search_results: this.metadata?.search_results || '',
      related_searches: this.metadata?.related_searches || '',
      search_queries: this.metadata?.search_queries || [],
      videos: this.metadata?.videos || [],
      share_url: this.metadata?.share_url || '',
      share_id: this.metadata?.share_id || '',
    }
  }

  private createFinalMetadata(): Record<string, any> {
    const conversationUrl = this.metadata?.conversation_url || ''
    const shareUrl = this.metadata?.share_url || ''
    const shareId = this.metadata?.share_id || ''
    return {
      ...this.createMessageMetadata(),
      chat2api: {
        provider: 'yuanbao',
        session_id: this.sessionId,
        conversation_id: this.metadata?.conversation_id || this.sessionId,
        message_id: this.metadata?.message_id || this.messageId || '',
        conversation_url: conversationUrl,
        share_url: shareUrl,
        share_id: shareId,
        videos: this.metadata?.videos || [],
        search_queries: this.metadata?.search_queries || [],
        ...this.createMessageMetadata(),
      },
    }
  }

  private createChunk(delta: Record<string, any>, finishReason: string | null = null, extras: Record<string, any> = {}): string {
    return `data: ${JSON.stringify({
      id: this.sessionId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extras,
    })}\n\n`
  }
}
