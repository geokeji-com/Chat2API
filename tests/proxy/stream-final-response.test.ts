import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  createFinalResponseTransform,
  shouldIncludeFinalResponse,
} from '../../src/main/proxy/streamFinalResponse.ts'

function sseEvent(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks.join('')
}

function parseSSE(output: string): string[] {
  return output.split('\n\n').filter(Boolean)
}

test('final response transform appends a complete response before DONE', async () => {
  const source = Readable.from([
    sseEvent({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }),
    sseEvent({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { reasoning_content: 'thinking ' }, finish_reason: null }],
    }),
    sseEvent({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    }),
    sseEvent({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      citations: [{ index: 1, title: 'Example', url: 'https://example.com' }],
      source_list: [{ index: 1, title: 'Example', url: 'https://example.com' }],
      chat2api: { shareUrl: 'https://example.com/share' },
    }),
    sseEvent('[DONE]'),
  ])

  const output = await collect(source.pipe(createFinalResponseTransform({
    model: 'fallback-model',
    responseId: 'fallback-id',
  })))
  const events = parseSSE(output)
  const finalChunk = JSON.parse(events.at(-2)!.slice('data: '.length))

  assert.equal(events.at(-1), 'data: [DONE]')
  assert.equal(finalChunk.object, 'chat.completion.chunk')
  assert.equal(finalChunk.choices[0].finish_reason, null)
  assert.equal(finalChunk.final_response.object, 'chat.completion')
  assert.equal(finalChunk.final_response.id, 'chatcmpl-1')
  assert.equal(finalChunk.final_response.model, 'test-model')
  assert.equal(finalChunk.final_response.choices[0].message.content, 'hello world')
  assert.equal(finalChunk.final_response.choices[0].message.reasoning_content, 'thinking ')
  assert.deepEqual(finalChunk.final_response.usage, {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  })
  assert.deepEqual(finalChunk.final_response.choices[0].message.citations, [{
    index: 1,
    title: 'Example',
    url: 'https://example.com',
  }])
  assert.deepEqual(finalChunk.final_response.choices[0].message.source_list, [{
    index: 1,
    title: 'Example',
    url: 'https://example.com',
  }])
  assert.deepEqual(finalChunk.final_response.chat2api, {
    shareUrl: 'https://example.com/share',
  })
})

test('final response transform aggregates fragmented tool calls', async () => {
  const source = Readable.from([
    sseEvent({
      id: 'chatcmpl-tools',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'tool-model',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":' },
          }],
        },
        finish_reason: null,
      }],
    }),
    sseEvent({
      id: 'chatcmpl-tools',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'tool-model',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '"weather"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    sseEvent('[DONE]'),
  ])

  const output = await collect(source.pipe(createFinalResponseTransform({
    model: 'tool-model',
    responseId: 'fallback-tools',
  })))
  const events = parseSSE(output)
  const finalResponse = JSON.parse(events.at(-2)!.slice('data: '.length)).final_response

  assert.equal(finalResponse.choices[0].message.content, null)
  assert.equal(finalResponse.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(finalResponse.choices[0].message.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: {
      name: 'search',
      arguments: '{"q":"weather"}',
    },
  }])
})

test('include final response option supports request body and header opt in', () => {
  assert.equal(shouldIncludeFinalResponse({ stream_options: { include_final_response: true } }), true)
  assert.equal(shouldIncludeFinalResponse({}, 'true'), true)
  assert.equal(shouldIncludeFinalResponse({}, '1'), true)
  assert.equal(shouldIncludeFinalResponse({}, undefined), false)
  assert.equal(shouldIncludeFinalResponse({ stream_options: { include_final_response: false } }, 'false'), false)
})
