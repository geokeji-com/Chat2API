import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { YuanbaoStreamHandler } from '../../src/main/proxy/adapters/yuanbao-stream.ts'
import { collectYuanbaoDetailMetadata, type YuanbaoResponseMetadata } from '../../src/main/proxy/adapters/yuanbao.ts'

function yuanbaoSse(events: unknown[]): Readable {
  return Readable.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks
}

function finalJsonChunk(output: string[]): any {
  const events = output.join('').split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  assert.ok(doneIndex > 0, 'expected a final JSON chunk before [DONE]')
  return JSON.parse(events[doneIndex - 1].slice('data: '.length))
}

function metadata(overrides: Partial<YuanbaoResponseMetadata> = {}): YuanbaoResponseMetadata {
  return {
    conversation_id: 'conv-1',
    message_id: 'conv-1_2',
    conversation_url: 'https://yuanbao.tencent.com/chat/naQivTmsDa/conv-1',
    share_url: '',
    answer_content: '完整回答',
    reasoning_content: '思考过程',
    citations: [{ index: 1, title: '来源一', url: 'https://example.com/1' }],
    source_list: [{ index: 1, title: '来源一', url: 'https://example.com/1' }],
    search_results: { keywords: [], webPages: [{ index: 1, title: '来源一', url: 'https://example.com/1' }] },
    related_searches: ['相关问题'],
    ...overrides,
  }
}

test('Yuanbao detail extracts reasoning and deduplicated sources from deep search', () => {
  const result = collectYuanbaoDetailMetadata({
    convs: [{
      speechesV2: [{
        content: [{
          type: 'deepSearch',
          contents: [
            { type: 'text', msg: '让我搜索一下最新信息。' },
            { type: 'toolCall', docs: [{ index: 2, title: '来源二', url: 'https://example.com/2' }] },
          ],
        }, {
          type: 'searchGuid',
          docs: [
            { index: 1, title: '来源一', url: 'https://example.com/1' },
            { index: 9, title: '重复来源二', url: 'https://example.com/2' },
          ],
        }],
      }],
    }],
  })

  assert.equal(result.reasoning_content, '让我搜索一下最新信息。')
  assert.deepEqual(result.citations, [
    { index: 1, title: '来源一', url: 'https://example.com/1' },
    { index: 2, title: '来源二', url: 'https://example.com/2' },
  ])
  assert.deepEqual(result.source_list, result.citations)
  assert.deepEqual(result.search_results, { keywords: [], webPages: result.citations })
})

test('Yuanbao stream exposes metadata and falls back to fetched answer content', async () => {
  const handler = new YuanbaoStreamHandler('yuanbao-t1-search', 'conv-1', async () => metadata())
  const output = await collect(await handler.handleStream(yuanbaoSse([
    { type: 'deepSearch', contents: [{ type: 'text', msg: '流式思考' }] },
    { type: 'searchGuid', docs: [{ index: 1, title: '来源一', url: 'https://example.com/1' }] },
  ])))
  const finalChunk = finalJsonChunk(output)

  assert.match(output.join(''), /"reasoning_content":"流式思考"/)
  assert.match(output.join(''), /"content":"完整回答"/)
  assert.equal(finalChunk.share_url, '')
  assert.deepEqual(finalChunk.citations, metadata().citations)
  assert.deepEqual(finalChunk.source_list, metadata().source_list)
  assert.deepEqual(finalChunk.related_searches, ['相关问题'])
  assert.equal(finalChunk.chat2api.conversation_url, 'https://yuanbao.tencent.com/chat/naQivTmsDa/conv-1')
  assert.equal(finalChunk.chat2api.share_url, '')
})

test('Yuanbao non-stream uses empty strings for unavailable response metadata', async () => {
  const handler = new YuanbaoStreamHandler('yuanbao', 'conv-empty', async () => metadata({
    conversation_id: 'conv-empty',
    message_id: '',
    conversation_url: '',
    answer_content: '',
    reasoning_content: '',
    citations: '',
    source_list: '',
    search_results: '',
    related_searches: '',
  }))
  const response: any = await handler.handleNonStream(yuanbaoSse([{ type: 'text', msg: '普通回答' }]))

  assert.equal(response.choices[0].message.content, '普通回答')
  assert.equal(response.choices[0].message.reasoning_content, '')
  assert.equal(response.choices[0].message.citations, '')
  assert.equal(response.choices[0].message.source_list, '')
  assert.equal(response.choices[0].message.related_searches, '')
  assert.equal(response.choices[0].message.share_url, '')
  assert.equal(response.share_url, '')
  assert.equal(response.chat2api.conversation_url, '')
})
