import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'

import { DeepSeekStreamHandler } from '../../src/main/proxy/adapters/deepseek-stream.ts'
import {
  buildDeepSeekCompletionPayload,
  normalizeDeepSeekFollowUpPrompt,
} from '../../src/main/proxy/adapters/providerModelOptions.ts'

function sse(events: unknown[]): Readable {
  return Readable.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

test('DeepSeek stream returns citations separately from content', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-1', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{
            type: 'SEARCH',
            results: [{
              url: 'https://www.nmc.cn/publish/forecast/ABJ/beijing.html',
              title: '北京-天气预报',
              cite_index: 1,
            }],
          }],
        },
      },
    },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/weather',
      title: '天气样例',
      cite_index: 2,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '北京明天天气多云[citation:1][citation:2]。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output
    .join('')
    .split('\n\n')
    .filter(Boolean)
  const joined = events.join('\n')
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.match(joined, /北京明天天气多云\[citation:1\]\[citation:2\]。/)
  assert.doesNotMatch(joined, /\[1\]: \[北京-天气预报\]\(https:\/\/www\.nmc\.cn\/publish\/forecast\/ABJ\/beijing\.html\)/)
  assert.doesNotMatch(joined, /\[2\]: \[天气样例\]\(https:\/\/example\.com\/weather\)/)
  assert.deepEqual(finalChunk.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [
    {
      index: 1,
      title: '北京-天气预报',
      url: 'https://www.nmc.cn/publish/forecast/ABJ/beijing.html',
    },
    {
      index: 2,
      title: '天气样例',
      url: 'https://example.com/weather',
    },
  ])
  assert.match(joined, /data: \[DONE\]/)
})

test('DeepSeek stream keeps existing cite index when merging duplicate URL without cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-duplicates', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/forecast',
      title: '初始天气来源',
      cite_index: 3,
    }] },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/forecast',
      title: '更新天气来源',
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 4, type: 'RESPONSE', content: '引用来源已更新。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  const events = joined.split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.deepEqual(finalChunk.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [{
    index: 3,
    title: '更新天气来源',
    url: 'https://example.com/forecast',
  }])
})

test('DeepSeek stream keeps existing cite index when duplicate URL has invalid cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-invalid-cite', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [
      {
        url: 'https://example.com/invalid-null',
        title: '初始空引用',
        cite_index: 1,
      },
      {
        url: 'https://example.com/invalid-string',
        title: '初始字符串引用',
        cite_index: 2,
      },
    ] },
    { p: 'response/fragments/-1/results', v: [
      {
        url: 'https://example.com/invalid-null',
        title: '更新空引用',
        cite_index: null,
      },
      {
        url: 'https://example.com/invalid-string',
        title: '更新字符串引用',
        cite_index: '9',
      },
    ] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 8, type: 'RESPONSE', content: '引用索引保持稳定。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  const events = joined.split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.deepEqual(finalChunk.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [
    {
      index: 1,
      title: '更新空引用',
      url: 'https://example.com/invalid-null',
    },
    {
      index: 2,
      title: '更新字符串引用',
      url: 'https://example.com/invalid-string',
    },
  ])
})

test('DeepSeek stream normalizes camelCase citeIndex search results', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-camel', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/camel',
      title: '驼峰引用',
      citeIndex: 4,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 5, type: 'RESPONSE', content: '引用格式正常。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  const events = joined.split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.equal(finalChunk.citations[0].index, 4)
  assert.equal(finalChunk.citations[0].title, '驼峰引用')
  assert.equal(finalChunk.citations[0].url, 'https://example.com/camel')
})

test('DeepSeek stream handles upstream DONE followed by stream end once', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-done', undefined, true)
  const source = Readable.from([
    `data: ${JSON.stringify({ response_message_id: '2', model_type: 'default' })}\n\n`,
    `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ id: 6, type: 'RESPONSE', content: '完成。' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.equal(countMatches(joined, /data: \[DONE\]/g), 1)
  assert.equal(countMatches(joined, /"finish_reason":"stop"/g), 1)
})

test('DeepSeek search-silent stream suppresses citations', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search-silent', 'session-silent', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/silent',
      title: '静默引用',
      cite_index: 5,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 7, type: 'RESPONSE', content: '不会附加引用。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /不会附加引用/)
  assert.doesNotMatch(joined, /\[5\]: \[静默引用\]\(https:\/\/example\.com\/silent\)/)
  assert.match(joined, /data: \[DONE\]/)
})

test('DeepSeek non-stream returns citations separately from content', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-1', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/weather',
      title: '天气样例',
      cite_index: 1,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '北京明天天气多云[citation:1]。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '北京明天天气多云[citation:1]。')
  assert.deepEqual(response.choices[0].message.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [{
    index: 1,
    title: '天气样例',
    url: 'https://example.com/weather',
  }])
  assert.equal(response.citations, undefined)
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream attaches share metadata', async () => {
  const handler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-share',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    async (messageId) => ({
      provider: 'deepseek',
      session_id: 'session-share',
      message_id: messageId,
      message_ids: ['user-message', messageId],
      conversation_url: 'https://chat.deepseek.com/a/chat/s/session-share',
      share_id: 'share-123',
      share_url: 'https://chat.deepseek.com/share/share-123',
    })
  )
  const source = sse([
    { response_message_id: 'assistant-message', model_type: 'default' },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '带分享链接。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.chat2api.provider, 'deepseek')
  assert.equal(response.chat2api.session_id, 'session-share')
  assert.equal(response.chat2api.message_id, 'assistant-message')
  assert.deepEqual(response.chat2api.message_ids, ['user-message', 'assistant-message'])
  assert.equal(response.chat2api.conversation_url, 'https://chat.deepseek.com/a/chat/s/session-share')
  assert.equal(response.chat2api.share_url, 'https://chat.deepseek.com/share/share-123')
})

test('DeepSeek stream attaches share metadata to final chunk before DONE', async () => {
  const handler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-stream-share',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    async (messageId) => ({
      provider: 'deepseek',
      session_id: 'session-stream-share',
      message_id: messageId,
      message_ids: ['user-stream', messageId],
      conversation_url: 'https://chat.deepseek.com/a/chat/s/session-stream-share',
      share_id: 'share-stream',
      share_url: 'https://chat.deepseek.com/share/share-stream',
    })
  )
  const source = sse([
    { response_message_id: 'assistant-stream', model_type: 'default' },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '流式分享链接。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output
    .join('')
    .split('\n\n')
    .filter(Boolean)

  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  assert.ok(doneIndex > 0)

  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))
  assert.equal(finalChunk.choices[0].finish_reason, 'stop')
  assert.equal(finalChunk.chat2api.provider, 'deepseek')
  assert.equal(finalChunk.chat2api.session_id, 'session-stream-share')
  assert.equal(finalChunk.chat2api.message_id, 'assistant-stream')
  assert.deepEqual(finalChunk.chat2api.message_ids, ['user-stream', 'assistant-stream'])
  assert.equal(finalChunk.chat2api.share_url, 'https://chat.deepseek.com/share/share-stream')
})

test('DeepSeek stream prefers ready message ID pair for share metadata', async () => {
  let receivedMessageId: unknown
  let receivedMessageIds: unknown
  const handler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-ready-share',
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    async (messageId, messageIds) => {
      receivedMessageId = messageId
      receivedMessageIds = messageIds
      return {
        provider: 'deepseek',
        session_id: 'session-ready-share',
        message_id: messageId,
        message_ids: messageIds,
        conversation_url: 'https://chat.deepseek.com/a/chat/s/session-ready-share',
        share_id: 'share-ready',
        share_url: 'https://chat.deepseek.com/share/share-ready',
      }
    },
  )
  const source = sse([
    { request_message_id: 1, response_message_id: 2, model_type: 'default' },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: 'ready 分享。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output.join('').split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.equal(receivedMessageId, 2)
  assert.deepEqual(receivedMessageIds, [1, 2])
  assert.deepEqual(handler.getShareMessageIds(), [1, 2])
  assert.deepEqual(finalChunk.chat2api.message_ids, [1, 2])
  assert.equal(finalChunk.chat2api.share_url, 'https://chat.deepseek.com/share/share-ready')
})

test('DeepSeek share message IDs include user-assistant pairs when only assistant ID is known', () => {
  const source = readFileSync('src/main/proxy/adapters/deepseek.ts', 'utf8')

  assert.match(source, /buildDeepSeekShareMessageIds/)
  assert.match(source, /numericMessageId\s*-\s*1/)
  assert.match(source, /return \[numericMessageId - 1, numericMessageId\]/)
})

test('DeepSeek completion payload matches web request shape and nulls model type for follow-ups', () => {
  assert.deepEqual(buildDeepSeekCompletionPayload({
    sessionId: 'session-first',
    parentMessageId: null,
    prompt: '首问',
    modelType: 'expert',
    searchEnabled: false,
    thinkingEnabled: true,
  }), {
    chat_session_id: 'session-first',
    parent_message_id: null,
    model_type: 'expert',
    prompt: '首问',
    ref_file_ids: [],
    thinking_enabled: true,
    search_enabled: false,
    action: null,
    preempt: false,
  })

  assert.deepEqual(buildDeepSeekCompletionPayload({
    sessionId: 'session-follow-up',
    parentMessageId: 6,
    prompt: '继续',
    modelType: 'expert',
    searchEnabled: true,
    thinkingEnabled: false,
  }), {
    chat_session_id: 'session-follow-up',
    parent_message_id: 6,
    model_type: null,
    prompt: '继续',
    ref_file_ids: [],
    thinking_enabled: false,
    search_enabled: true,
    action: null,
    preempt: false,
  })
})

test('DeepSeek follow-up prompts do not include synthetic speaker prefixes', () => {
  assert.equal(normalizeDeepSeekFollowUpPrompt('展开说说'), '展开说说')
  assert.equal(normalizeDeepSeekFollowUpPrompt('<｜User｜>展开说说'), '展开说说')
  assert.equal(normalizeDeepSeekFollowUpPrompt('<|User|>展开说说'), '展开说说')
})

test('DeepSeek stream ignores expert TIP fragments and routes thinking separately', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-pro-think', 'session-tip', undefined, false)
  const source = sse([
    { request_message_id: 1, response_message_id: 2, model_type: 'expert' },
    {
      v: {
        response: {
          parent_id: 1,
          message_id: 2,
          thinking_enabled: true,
          fragments: [
            {
              id: 2,
              type: 'TIP',
              content: '专家模式暂不支持搜索，请使用快速模式',
            },
            {
              id: 3,
              type: 'THINK',
              content: '先分析需求。',
            },
          ],
        },
      },
    },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 4, type: 'ANSWER', content: '推荐选一级能效空调。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /"reasoning_content":"先分析需求。"/)
  assert.match(joined, /"content":"推荐选一级能效空调。"/)
  assert.doesNotMatch(joined, /专家模式暂不支持搜索/)
})

test('DeepSeek non-stream ignores search control fragments and keeps answer content', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-tool-search', undefined, true)
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          search_enabled: true,
          fragments: [{
            id: 2,
            type: 'TOOL_SEARCH',
            content: null,
            queries: [{ query: 'GEO 优化公司' }],
            related_searches: [{ question: 'GEO 优化怎么做？' }],
            results: [],
          }],
        },
      },
    },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/geo',
      title: 'GEO 样例',
      cite_index: 1,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '可以重点看技术能力[citation:1]。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '可以重点看技术能力[citation:1]。')
  assert.equal(response.choices[0].message.citations[0].title, 'GEO 样例')
  assert.deepEqual(response.choices[0].message.search_queries, ['GEO 优化公司'])
  assert.deepEqual(response.choices[0].message.related_searches, ['GEO 优化怎么做？'])
})

test('DeepSeek stream final chunk exposes TOOL_SEARCH queries and related searches', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-query-stream', undefined, true)
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{
            id: 1,
            type: 'TOOL_SEARCH',
            content: null,
            queries: [{ query: '户外防晒推荐' }, { query: '夏天防晒衣' }],
          }],
        },
      },
    },
    {
      p: 'response/related_searches',
      v: [
        { question: '夏天户外怎么补防晒？' },
        { question: '防晒衣 UPF 怎么选？' },
      ],
    },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 2, type: 'RESPONSE', content: '建议软硬防晒结合。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output.join('').split('\n\n').filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.deepEqual(finalChunk.search_queries, ['户外防晒推荐', '夏天防晒衣'])
  assert.deepEqual(finalChunk.related_searches, ['夏天户外怎么补防晒？', '防晒衣 UPF 怎么选？'])
})

test('DeepSeek stream handler uses requested alias semantics when actual model is primary', async () => {
  const searchHandler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-semantic-search',
    undefined,
    false,
    undefined,
    undefined,
    'deepseek-v4-flash-search',
  )
  const searchResponse: any = await searchHandler.handleNonStream(sse([{ v: '搜索正文。' }]))

  assert.equal(searchResponse.model, 'deepseek-v4-flash')
  assert.equal(searchResponse.choices[0].message.content, '搜索正文。')

  const thinkingHandler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-semantic-thinking',
    undefined,
    false,
    undefined,
    undefined,
    'DeepSeek-R1',
  )
  const thinkingResponse: any = await thinkingHandler.handleNonStream(sse([{ v: '思考内容。' }]))

  assert.equal(thinkingResponse.model, 'deepseek-v4-flash')
  assert.equal(thinkingResponse.choices[0].message.reasoning_content, '思考内容。')
  assert.equal(thinkingResponse.choices[0].message.content, '')
})

test('DeepSeek non-stream applies batched cite index patches to search results', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-batch', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/batch',
      title: '批量引用',
    }] },
    { p: 'response/fragments/-1/results', o: 'BATCH', v: [{ p: '0/cite_index', v: 1 }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 9, type: 'RESPONSE', content: '批量引用已生成。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '批量引用已生成。')
  assert.equal(response.choices[0].message.citations[0].index, 1)
  assert.equal(response.choices[0].message.citations[0].title, '批量引用')
  assert.equal(response.choices[0].message.citations[0].url, 'https://example.com/batch')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream returns citation without leading blank lines when content is empty', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-empty-content', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/empty',
      title: '空正文引用',
      cite_index: 1,
    }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '')
  assert.equal(response.choices[0].message.citations[0].index, 1)
  assert.equal(response.choices[0].message.citations[0].title, '空正文引用')
  assert.equal(response.choices[0].message.citations[0].url, 'https://example.com/empty')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream keeps existing cite index when duplicate URL has invalid cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-nonstream-invalid-cite', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/nonstream-invalid',
      title: '初始引用',
      cite_index: 1,
    }] },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/nonstream-invalid',
      title: '更新引用',
      cite_index: '9',
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 10, type: 'RESPONSE', content: '引用索引稳定。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '引用索引稳定。')
  assert.equal(response.choices[0].message.citations[0].index, 1)
  assert.equal(response.choices[0].message.citations[0].title, '更新引用')
  assert.equal(response.choices[0].message.citations[0].url, 'https://example.com/nonstream-invalid')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream keeps tool call content null when citations are present', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-tool-citation', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/tool',
      title: '工具引用',
      cite_index: 1,
    }] },
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [{
        id: 11,
        type: 'RESPONSE',
        content: '[function_calls][call:get_weather]{"city":"北京"}[/call][/function_calls]',
      }],
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, null)
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.tool_calls.length, 1)
  assert.equal(response.choices[0].message.citations[0].index, 1)
  assert.equal(response.choices[0].message.citations[0].url, 'https://example.com/tool')
})

test('DeepSeek non-search responses preserve search text at fragment start', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-preserve-search', undefined, false)
  const exactContent = [
    'search.example.com',
    'Search should remain at the beginning.',
    'https://search-api.example.com',
    'https://example.com/test?search=value',
  ].join('\n')
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: exactContent }],
        },
      },
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, exactContent)
})

test('DeepSeek non-search streams preserve search text at chunk start', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-preserve-stream-search', undefined, false)
  const source = sse([
    { v: { response: { thinking_enabled: false } } },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 12, type: 'RESPONSE', content: 'search.example.com' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /"content":"search\.example\.com"/)
  assert.doesNotMatch(joined, /"content":"\.example\.com"/)
})

test('DeepSeek search responses still strip explicit search control markers', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-strip-search-marker', undefined, true)
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: 'SEARCH 搜索正文。' }],
        },
      },
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '搜索正文。')
})

test('DeepSeek adapter always creates a fresh provider-side session', () => {
  const source = readFileSync('src/main/proxy/adapters/deepseek.ts', 'utf8')

  assert.doesNotMatch(source, /sessionCache/)
  assert.doesNotMatch(source, /Date\.now\(\)\s*-\s*cached\.createdAt/)
  assert.match(source, /\/v0\/chat_session\/create/)
})
