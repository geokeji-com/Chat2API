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

function parseSseEvents(output: string[]): string[] {
  return output.join('').split('\n\n').filter(Boolean)
}

function finalJsonChunk(output: string[]): any {
  const events = parseSseEvents(output)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  assert.ok(doneIndex > 0, 'expected a final JSON chunk before [DONE]')
  return JSON.parse(events[doneIndex - 1].slice('data: '.length))
}

function streamedContent(output: string[]): string {
  return parseSseEvents(output)
    .filter(event => event.startsWith('data: {'))
    .map(event => JSON.parse(event.slice('data: '.length)))
    .map(chunk => chunk.choices?.[0]?.delta?.content)
    .filter((content): content is string => typeof content === 'string')
    .join('')
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

function qwenRichSourceEvent(status: string = 'complete') {
  return {
    communication: {
      sessionid: 'session-rich',
      reqid: 'req-rich',
    },
    data: {
      messages: [{
        mime_type: 'multi_load/iframe',
        content: 'GEO优化公司建议优先看行业案例、可验证信源覆盖和投放后数据复盘。\n[(video_note_list_1)]\n\n视频笔记列表\n- GEO优化案例视频笔记 https://video.example.com/geo-note',
        status,
        meta_data: {
          web_search: {
            source_list: [{
              title: 'GEO优化公司推荐榜',
              pc_url: 'https://example.com/geo-agencies',
              desc: '对 GEO 优化服务商的案例、交付方式和报价进行整理。',
              source_name: 'Example Research',
              cite_index: 2,
            }],
            search_query: 'GEO优化公司 推荐',
          },
          video_note_list: [{
            cardTitle: 'GEO优化案例视频笔记',
            jump_url: 'https://video.example.com/geo-note',
            subtitle: '视频笔记摘要',
            media_name: 'Example Video',
          }],
          opaque_payload: JSON.stringify({
            reference_list: [{
              docTitle: 'GEO优化服务对比',
              doc_url: 'https://example.com/geo-comparison',
              abstract: '从案例、数据和团队配置对比 GEO 服务。',
              source_name: 'Example Docs',
            }],
          }),
        },
      }],
    },
  }
}

function qwenSearchCandidatesAndSourcesEvent() {
  const searchCandidates = Array.from({ length: 17 }, (_, index) => ({
    title: `搜索候选 ${index + 1}`,
    url: `https://example.com/search-${index + 1}`,
  }))

  const sourceList = Array.from({ length: 7 }, (_, index) => ({
    title: `引用来源 ${index + 1}`,
    url: `https://example.com/search-${index + 1}`,
    cite_index: index + 1,
    source_name: 'Example Source',
    snippet: `第 ${index + 1} 篇被引用资料的内容片段。`,
  }))

  const sourceGroup = (groupIndex: number, refNums: number[]) => ({
    type: 'source_group_web',
    source_seq: `source_group_web_${groupIndex}`,
    content: {
      list: [{
        type: 'source',
        source_seq: `source_${groupIndex}`,
        content: {
          list: refNums.map(refNum => ({
            ...sourceList[refNum - 1],
            ref_num: String(refNum),
          })),
        },
      }],
    },
  })

  return {
    communication: {
      sessionid: 'session-17-7',
      reqid: 'req-17-7',
    },
    data: {
      messages: [{
        mime_type: 'multi_load/iframe',
        content: [
          '最终回答只引用其中 7 篇资料[[source_group_web_1]]。',
          '第三个原始角标会映射为多个真实引用[[source_group_web_3]]。',
          '非连续引用会重排[[source_group_web_4]][[source_group_web_10]]。',
          '缺少左括号的角标也会修正source_group_web_12]]。',
          '最后一个引用[[source_group_web_13]]。',
          '未映射角标保持原样[[source_group_web_99]]。',
        ].join('\n'),
        status: 'complete',
        meta_data: {
          multi_load: [
            sourceGroup(1, [3]),
            sourceGroup(3, [1, 5]),
            sourceGroup(4, [4]),
            sourceGroup(10, [2]),
            sourceGroup(12, [6]),
            sourceGroup(13, [7]),
          ],
          web_search: {
            results: searchCandidates,
            source_list: sourceList,
            search_query: 'GEO 优化公司 推荐',
          },
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
      share_url: 'https://www.qianwen.com/share/chat/share-qwen',
    }),
  )

  const output = await collect(handler.handleStream(qwenSse([qwenAnswerEvent()])))
  const finalChunk = finalJsonChunk(output)

  assert.match(output.join(''), /夏天防晒建议选择 SPF50\+/)
  assert.match(output.join(''), /"reasoning_content":"先区分通勤、户外和敏感肌，再给出防晒建议。"/)
  assert.equal(finalChunk.chat2api.share_id, 'share-qwen')
  assert.equal(finalChunk.chat2api.share_url, 'https://www.qianwen.com/share/chat/share-qwen')
  assert.equal(finalChunk.chat2api.conversation_url, 'https://www.qianwen.com/chat/session-qwen')
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
  assert.equal(finalChunk.sources, undefined)
  assert.equal(finalChunk.source_list, undefined)
  assert.equal(finalChunk.search_results, undefined)
  assert.deepEqual(finalChunk.chat2api.citations, finalChunk.citations)
  assert.deepEqual(finalChunk.chat2api.search_results.webPages, finalChunk.citations)
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
      share_url: 'https://www.qianwen.com/share/chat/share-qwen-nonstream',
    }),
  )

  const response: any = await handler.handleNonStream(qwenSse([qwenAnswerEvent()]))

  assert.equal(response.choices[0].message.content, '夏天防晒建议选择 SPF50+、PA++++，并按场景补涂。')
  assert.equal(response.choices[0].message.reasoning_content, '先区分通勤、户外和敏感肌，再给出防晒建议。')
  assert.equal(response.chat2api.share_id, 'share-qwen-nonstream')
  assert.equal(response.chat2api.share_url, 'https://www.qianwen.com/share/chat/share-qwen-nonstream')
  assert.equal(response.chat2api.conversation_url, 'https://www.qianwen.com/chat/session-qwen')
  assert.deepEqual(response.choices[0].message.search_queries, ['夏天 防晒 推荐'])
  assert.deepEqual(response.choices[0].message.related_searches, ['夏天户外怎么补涂防晒？'])
  assert.equal(response.choices[0].message.citations[0].title, '国家药监局防晒化妆品科普')
  assert.equal(response.choices[0].message.sources, undefined)
  assert.equal(response.choices[0].message.source_list, undefined)
  assert.equal(response.choices[0].message.search_results, undefined)
  assert.equal(response.citations, undefined)
  assert.equal(response.sources, undefined)
  assert.equal(response.chat2api.search_results.webPages[0].url, 'https://www.nmpa.gov.cn/example/sunscreen')
})

test('Qwen stream extracts rich source cards and strips video-note list artifacts from content', async () => {
  const handler = new QwenStreamHandler(
    'Qwen',
    undefined,
    undefined,
    'session-rich',
    'req-rich',
    async (sessionId, reqId) => ({
      provider: 'qwen',
      session_id: sessionId,
      req_id: reqId,
      share_id: 'share-rich',
      share_url: 'https://www.qianwen.com/share/chat/share-rich',
    }),
  )

  const output = await collect(handler.handleStream(qwenSse([qwenRichSourceEvent()])))
  const outputText = output.join('')
  const finalChunk = finalJsonChunk(output)

  assert.match(outputText, /GEO优化公司建议优先看行业案例/)
  assert.doesNotMatch(outputText, /视频笔记列表/)
  assert.doesNotMatch(outputText, /video_note_list_1/)
  assert.deepEqual(finalChunk.search_queries, ['GEO优化公司 推荐'])
  assert.equal(finalChunk.related_searches, undefined)
  assert.deepEqual(finalChunk.citations.map((source: any) => source.url).sort(), [
    'https://example.com/geo-agencies',
    'https://example.com/geo-comparison',
  ])
  assert.equal(finalChunk.sources, undefined)
  assert.equal(finalChunk.source_list, undefined)
  assert.equal(finalChunk.search_results, undefined)
  assert.deepEqual(finalChunk.chat2api.search_results.webPages.map((source: any) => source.url).sort(), [
    'https://example.com/geo-agencies',
    'https://example.com/geo-comparison',
    'https://video.example.com/geo-note',
  ])
})

test('Qwen stream keeps search candidates separate from final source list', async () => {
  const handler = new QwenStreamHandler(
    'Qwen',
    undefined,
    undefined,
    'session-17-7',
    'req-17-7',
    async (sessionId, reqId) => ({
      provider: 'qwen',
      session_id: sessionId,
      req_id: reqId,
      share_id: 'share-17-7',
      share_url: 'https://www.qianwen.com/share/chat/share-17-7',
    }),
  )

  const output = await collect(handler.handleStream(qwenSse([qwenSearchCandidatesAndSourcesEvent()])))
  const answerContent = streamedContent(output)
  const finalChunk = finalJsonChunk(output)

  assert.match(answerContent, /最终回答只引用其中 7 篇资料\[citation:3\]。/)
  assert.match(answerContent, /非连续引用会重排\[citation:4\]\[citation:2\]。/)
  assert.match(answerContent, /缺少左括号的角标也会修正\[citation:6\]。/)
  assert.match(answerContent, /未映射角标保持原样\[\[source_group_web_99\]\]。/)
  assert.doesNotMatch(answerContent, /source_group_web_(?:1|3|4|10|12|13)\]\]/)
  assert.doesNotMatch(answerContent, /\[citation:8\]/)
  assert.equal(finalChunk.search_results, undefined)
  assert.equal(finalChunk.sources, undefined)
  assert.equal(finalChunk.source_list, undefined)
  assert.equal(finalChunk.chat2api.search_results.webPages.length, 17)
  assert.equal(finalChunk.citations.length, 7)
  assert.deepEqual(finalChunk.chat2api.citations, finalChunk.citations)
  assert.equal(finalChunk.related_searches, undefined)
  assert.deepEqual(
    finalChunk.citations.map((source: any) => source.index),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.deepEqual(
    finalChunk.citations.map((source: any) => source.url),
    Array.from({ length: 7 }, (_, index) => `https://example.com/search-${index + 1}`),
  )
  assert.ok(finalChunk.citations.every((source: any) => typeof source.snippet === 'string' && source.snippet.includes('内容片段')))
})

test('Qwen stream close still emits final metadata chunk when upstream omits complete event', async () => {
  const handler = new QwenStreamHandler(
    'Qwen',
    undefined,
    undefined,
    'session-rich',
    'req-rich',
    async (sessionId, reqId) => ({
      provider: 'qwen',
      session_id: sessionId,
      req_id: reqId,
      share_id: 'share-close',
      share_url: 'https://www.qianwen.com/share/chat/share-close',
    }),
  )

  const output = await collect(handler.handleStream(qwenSse([qwenRichSourceEvent('generating')])))
  const finalChunk = finalJsonChunk(output)

  assert.equal(finalChunk.choices[0].finish_reason, 'stop')
  assert.equal(finalChunk.chat2api.share_id, 'share-close')
  assert.equal(finalChunk.chat2api.share_url, 'https://www.qianwen.com/share/chat/share-close')
  assert.equal(finalChunk.citations.length, 2)
  assert.equal(finalChunk.sources, undefined)
  assert.equal(finalChunk.source_list, undefined)
})
