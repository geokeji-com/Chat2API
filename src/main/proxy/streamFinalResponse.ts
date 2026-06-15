import { Transform } from 'stream'
import type { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from './types'

type Usage = NonNullable<ChatCompletionResponse['usage']> & Record<string, any>

const STANDARD_CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage'])
const MESSAGE_EXTRA_KEYS = new Set(['citations', 'source_list', 'search_results', 'search_queries', 'related_searches', 'share_url'])

export interface FinalResponseTransformOptions {
  model: string
  responseId: string
}

export function shouldIncludeFinalResponse(
  request: Pick<ChatCompletionRequest, 'stream_options'>,
  headerValue?: string
): boolean {
  if (request.stream_options?.include_final_response === true) {
    return true
  }

  if (!headerValue) {
    return false
  }

  return ['true', '1', 'yes', 'on'].includes(headerValue.trim().toLowerCase())
}

export class StreamFinalResponseAccumulator {
  private content = ''
  private reasoningContent = ''
  private finishReason: ChatCompletionResponse['choices'][number]['finish_reason'] = null
  private usage: Usage | undefined
  private id: string
  private model: string
  private created = Math.floor(Date.now() / 1000)
  private toolCalls: ToolCall[] = []
  private messageExtras: Record<string, any> = {}
  private responseExtras: Record<string, any> = {}

  constructor(options: FinalResponseTransformOptions) {
    this.id = options.responseId
    this.model = options.model
  }

  addChunk(chunk: any): void {
    if (!chunk || typeof chunk !== 'object') {
      return
    }

    if (typeof chunk.id === 'string' && chunk.id) {
      this.id = chunk.id
    }
    if (typeof chunk.model === 'string' && chunk.model) {
      this.model = chunk.model
    }
    if (typeof chunk.created === 'number') {
      this.created = chunk.created
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      this.usage = { ...chunk.usage }
    }

    this.collectProviderExtras(chunk)

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (!choice) {
      return
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason
    }

    const delta = choice.delta
    if (delta && typeof delta === 'object') {
      if (typeof delta.content === 'string') {
        this.content += delta.content
      }
      if (typeof delta.reasoning_content === 'string') {
        this.reasoningContent += delta.reasoning_content
      }
      if (Array.isArray(delta.tool_calls)) {
        this.mergeToolCalls(delta.tool_calls)
      }
    }

    const message = choice.message
    if (message && typeof message === 'object') {
      if (typeof message.content === 'string') {
        this.content += message.content
      }
      if (typeof message.reasoning_content === 'string') {
        this.reasoningContent += message.reasoning_content
      }
      if (Array.isArray(message.tool_calls)) {
        this.mergeToolCalls(message.tool_calls)
      }
      for (const key of MESSAGE_EXTRA_KEYS) {
        if (message[key] !== undefined) {
          this.messageExtras[key] = message[key]
        }
      }
    }
  }

  createFinalResponse(): ChatCompletionResponse & Record<string, any> {
    const finalToolCalls = this.toolCalls
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(({ index: _index, ...toolCall }) => toolCall)

    const message: Record<string, any> = {
      role: 'assistant',
      content: finalToolCalls.length > 0 ? null : (this.content || null),
    }

    if (this.reasoningContent) {
      message.reasoning_content = this.reasoningContent
    }
    if (finalToolCalls.length > 0) {
      message.tool_calls = finalToolCalls
    }
    Object.assign(message, this.messageExtras)

    let finishReason = this.finishReason || 'stop'
    if (finalToolCalls.length > 0 && (!this.finishReason || this.finishReason === 'stop')) {
      finishReason = 'tool_calls'
    }

    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
      usage: this.normalizeUsage(),
      ...this.responseExtras,
    }
  }

  createFinalChunk(): ChatCompletionResponse & { final_response: ChatCompletionResponse & Record<string, any> } {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: null,
      }],
      final_response: this.createFinalResponse(),
    }
  }

  private collectProviderExtras(chunk: Record<string, any>): void {
    for (const [key, value] of Object.entries(chunk)) {
      if (value === undefined || STANDARD_CHUNK_KEYS.has(key)) {
        continue
      }
      if (MESSAGE_EXTRA_KEYS.has(key)) {
        this.messageExtras[key] = value
      } else {
        this.responseExtras[key] = value
      }
    }
  }

  private mergeToolCalls(deltaToolCalls: any[]): void {
    for (const deltaToolCall of deltaToolCalls) {
      const index = typeof deltaToolCall.index === 'number' ? deltaToolCall.index : this.toolCalls.length
      let toolCall = this.toolCalls.find((existing) => existing.index === index)

      if (!toolCall) {
        toolCall = {
          index,
          id: '',
          type: 'function',
          function: {
            name: '',
            arguments: '',
          },
        }
        this.toolCalls.push(toolCall)
      }

      if (deltaToolCall.id) {
        toolCall.id = deltaToolCall.id
      }
      if (deltaToolCall.type) {
        toolCall.type = deltaToolCall.type
      }
      if (deltaToolCall.function?.name) {
        toolCall.function.name = deltaToolCall.function.name
      }
      if (deltaToolCall.function?.arguments) {
        toolCall.function.arguments += deltaToolCall.function.arguments
      }
    }
  }

  private normalizeUsage(): Usage {
    const usage = this.usage || {}
    const promptTokens = toTokenCount(usage.prompt_tokens)
    const completionTokens = toTokenCount(usage.completion_tokens)
    const totalTokens = toTokenCount(usage.total_tokens, promptTokens + completionTokens)

    return {
      ...usage,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    }
  }
}

export function createFinalResponseTransform(options: FinalResponseTransformOptions): Transform {
  const accumulator = new StreamFinalResponseAccumulator(options)
  let buffer = ''
  let finalChunkSent = false

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += chunk.toString()
        const events = splitCompleteSSEEvents(buffer)
        buffer = events.remainder

        for (const eventText of events.completeEvents) {
          const data = extractSSEData(eventText)
          if (data === '[DONE]') {
            if (!finalChunkSent) {
              this.push(formatSSEJSON(accumulator.createFinalChunk()))
              finalChunkSent = true
            }
            this.push(eventText)
            continue
          }

          if (data !== undefined) {
            try {
              accumulator.addChunk(JSON.parse(data))
            } catch {
              // Non-JSON SSE events are left untouched.
            }
          }

          this.push(eventText)
        }

        callback()
      } catch (error) {
        callback(error as Error)
      }
    },
    flush(callback) {
      if (buffer) {
        const eventText = buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`
        const data = extractSSEData(eventText)
        if (data && data !== '[DONE]') {
          try {
            accumulator.addChunk(JSON.parse(data))
          } catch {
            // Non-JSON trailing data is left untouched.
          }
        }
        this.push(eventText)
      }
      callback()
    },
  })
}

function splitCompleteSSEEvents(buffer: string): { completeEvents: string[]; remainder: string } {
  const completeEvents: string[] = []
  let remainder = buffer

  while (true) {
    const match = /\r?\n\r?\n/.exec(remainder)
    if (!match || match.index === undefined) {
      break
    }

    const endIndex = match.index + match[0].length
    completeEvents.push(remainder.slice(0, endIndex))
    remainder = remainder.slice(endIndex)
  }

  return { completeEvents, remainder }
}

function extractSSEData(eventText: string): string | undefined {
  const dataLines: string[] = []
  const lines = eventText.replace(/\r\n/g, '\n').split('\n')

  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue
    }

    let value = line.slice(5)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }
    dataLines.push(value)
  }

  if (dataLines.length === 0) {
    return undefined
  }

  return dataLines.join('\n')
}

function formatSSEJSON(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function toTokenCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
