import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { QwenStreamHandler } from '../../src/main/proxy/adapters/qwen.ts'

function qwenSse(events: unknown[]): Readable {
  return Readable.from(events.map(event => `data:${JSON.stringify(event)}\n\n`))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks
}

function qwenAnswerEvent() {
  return {
    communication: {
      sessionid: 'session-qwen',
      reqid: 'req-qwen',
    },
    data: {
      messages: [{
        mime_type: 'multi_load/iframe',
        content: '夏天防晒建议选择 SPF50+、PA++++，并按场景补涂。',
        status: 'complete',
        meta_data: {
          multi_load: [{
            type: 'deep_think',
            content: { think_content: '先区分通勤、户外和敏感肌，再给出防晒建议。' },
          }],
          search_results: [{
            title: '国家药监局防晒化妆品科普',
            url: 'https://www.nmpa.gov.cn/example/sunscreen',
            snippet: '防晒产品应结合 SPF、PA 和使用场景选择。',
            cite_index: 1,
            source_name: '国家药监局',
          }],
          queries: [{ query: '夏天 防晒 推荐' }],
          related_searches: [{ question: '夏天户外怎么补涂防晒？' }],
        },
      }],
    },
  }
}

test('Qwen stream final chunk exposes answer metadata and share link', async () => {
  const handler = new QwenStreamHandler(
    'Qwen',
    undefined,
    undefined,
    'session-qwen',
    'req-qwen',
    async (sessionId, reqId) => ({
      provider: 'qwen',
      session_id: sessionId,
      req_id: reqId,
      share_id: 'share-qwen',
      share_url: 'https://www.qianwen.com/share/chat?biz_id=ai_qwen&env=prod&qwcontainer=qk&share_id=share-qwen',
    }),
  )

  const output = await collect(handler.handleStream(qwenSse([qwenAnswerEvent()])))
  const events = output.join('').split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.match(output.join(''), /夏天防晒建议选择 SPF50\+/)
  assert.match(output.join(''), /"reasoning_content":"先区分通勤、户外和敏感肌，再给出防晒建议。"/)
  assert.equal(finalChunk.chat2api.share_id, 'share-qwen')
  assert.equal(finalChunk.chat2api.share_url, 'https://www.qianwen.com/share/chat?biz_id=ai_qwen&env=prod&qwcontainer=qk&share_id=share-qwen')
  assert.deepEqual(finalChunk.search_queries, ['夏天 防晒 推荐'])
  assert.deepEqual(finalChunk.related_searches, ['夏天户外怎么补涂防晒？'])
  assert.deepEqual(finalChunk.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
    snippet: citation.snippet,
    siteName: citation.siteName,
  })), [{
    index: 1,
    title: '国家药监局防晒化妆品科普',
    url: 'https://www.nmpa.gov.cn/example/sunscreen',
    snippet: '防晒产品应结合 SPF、PA 和使用场景选择。',
    siteName: '国家药监局',
  }])
  assert.deepEqual(finalChunk.search_results.webPages, finalChunk.citations)
})

test('Qwen non-stream response exposes reasoning, sources, queries, related searches, and share link', async () => {
  const handler = new QwenStreamHandler(
    'Qwen',
    undefined,
    undefined,
    'session-qwen',
    'req-qwen',
    async (sessionId, reqId) => ({
      provider: 'qwen',
      session_id: sessionId,
      req_id: reqId,
      share_id: 'share-qwen-nonstream',
      share_url: 'https://www.qianwen.com/share/chat?biz_id=ai_qwen&env=prod&qwcontainer=qk&share_id=share-qwen-nonstream',
    }),
  )

  const response: any = await handler.handleNonStream(qwenSse([qwenAnswerEvent()]))

  assert.equal(response.choices[0].message.content, '夏天防晒建议选择 SPF50+、PA++++，并按场景补涂。')
  assert.equal(response.choices[0].message.reasoning_content, '先区分通勤、户外和敏感肌，再给出防晒建议。')
  assert.equal(response.chat2api.share_id, 'share-qwen-nonstream')
  assert.equal(response.chat2api.share_url, 'https://www.qianwen.com/share/chat?biz_id=ai_qwen&env=prod&qwcontainer=qk&share_id=share-qwen-nonstream')
  assert.deepEqual(response.choices[0].message.search_queries, ['夏天 防晒 推荐'])
  assert.deepEqual(response.choices[0].message.related_searches, ['夏天户外怎么补涂防晒？'])
  assert.equal(response.choices[0].message.citations[0].title, '国家药监局防晒化妆品科普')
  assert.equal(response.choices[0].message.search_results.webPages[0].url, 'https://www.nmpa.gov.cn/example/sunscreen')
})
