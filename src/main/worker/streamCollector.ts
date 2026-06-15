import type { Readable } from 'stream'
import type { ChatCompletionResponse } from '../proxy/types.ts'

export async function collectFinalResponseFromSse(
  stream: NodeJS.ReadableStream,
): Promise<ChatCompletionResponse & Record<string, unknown>> {
  let buffer = ''
  let finalResponse: (ChatCompletionResponse & Record<string, unknown>) | undefined
  let lastChunk: Record<string, any> | undefined

  for await (const chunk of stream as Readable) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''

    for (const part of parts) {
      const data = extractSseData(part)
      if (!data || data === '[DONE]') {
        continue
      }

      try {
        const parsed = JSON.parse(data)
        if (parsed.final_response) {
          finalResponse = parsed.final_response
        } else {
          lastChunk = parsed
        }
      } catch {
        // Ignore provider comments or non-JSON SSE payloads.
      }
    }
  }

  if (finalResponse) {
    return finalResponse
  }

  if (lastChunk?.choices?.[0]?.message) {
    return lastChunk as ChatCompletionResponse & Record<string, unknown>
  }

  throw new Error('No final response was emitted by stream')
}

function extractSseData(eventText: string): string | undefined {
  const dataLines = eventText
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())

  return dataLines.length > 0 ? dataLines.join('\n') : undefined
}
