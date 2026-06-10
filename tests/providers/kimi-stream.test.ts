import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { KimiStreamHandler } from '../../src/main/proxy/adapters/kimi.ts'
import { encodeKimiGrpcFrame } from '../../src/main/proxy/adapters/providerModelOptions.ts'

function grpcFrames(events: unknown[]): Readable {
  return Readable.from(events.map(event => encodeKimiGrpcFrame(event)))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks
}

test('Kimi non-stream returns search keywords and citations', async () => {
  const handler = new KimiStreamHandler('kimi-k2.6', 'session-1')
  const source = grpcFrames([
    { chat: { id: 'chat-1' } },
    {
      message: {
        id: 'assistant-1',
        role: 'assistant',
        refs: {
          usedSearchChunks: [{
            index: 2,
            base: {
              title: 'GEO 优化公司榜单',
              url: 'https://example.com/geo',
              snippet: '推荐 GEO 优化服务商。',
              siteName: 'Example',
            },
          }],
        },
      },
    },
    {
      op: 'append',
      block: {
        content: {
          case: 'search',
          value: {
            keywords: ['GEO优化公司推荐', '生成式引擎优化服务商'],
            webPages: [{
              title: 'GEO 服务商指南',
              url: 'https://example.com/guide',
            }],
          },
        },
      },
    },
    {
      op: 'append',
      mask: 'block.text.content',
      block: { text: { content: '推荐列表如下。' } },
    },
    { done: {} },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.id, 'chat-1')
  assert.equal(response.choices[0].message.content, '推荐列表如下。')
  assert.deepEqual(response.choices[0].message.search_results.keywords, [
    'GEO优化公司推荐',
    '生成式引擎优化服务商',
  ])
  assert.deepEqual(response.choices[0].message.search_queries, [
    'GEO优化公司推荐',
    '生成式引擎优化服务商',
  ])
  assert.deepEqual(response.choices[0].message.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [
    {
      index: 1,
      title: 'GEO 服务商指南',
      url: 'https://example.com/guide',
    },
    {
      index: 2,
      title: 'GEO 优化公司榜单',
      url: 'https://example.com/geo',
    },
  ])
  assert.equal(response.choices[0].message.search_results.webPages.length, 2)
})

test('Kimi stream emits citations on final chunk', async () => {
  const handler = new KimiStreamHandler('kimi-k2.6', 'session-stream')
  const source = grpcFrames([
    { chat: { id: 'chat-stream' } },
    {
      message: {
        id: 'assistant-stream',
        role: 'assistant',
        references: [{
          type: 'CITE',
          items: [{
            content: {
              case: 'search',
              value: {
                title: 'Kimi 搜索引用',
                url: 'https://example.com/kimi-ref',
              },
            },
          }],
        }],
      },
    },
    {
      op: 'append',
      block: {
        content: {
          case: 'search',
          value: {
            keywords: ['Kimi 搜索'],
            webPages: [],
          },
        },
      },
    },
    {
      op: 'append',
      mask: 'block.text.content',
      block: { text: { content: '带引用的回答。' } },
    },
    { done: {} },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output
    .join('')
    .split('\n\n')
    .filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.equal(finalChunk.id, 'chat-stream')
  assert.equal(finalChunk.choices[0].finish_reason, 'stop')
  assert.deepEqual(finalChunk.search_results.keywords, ['Kimi 搜索'])
  assert.deepEqual(finalChunk.search_queries, ['Kimi 搜索'])
  assert.deepEqual(finalChunk.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [{
    index: 1,
    title: 'Kimi 搜索引用',
    url: 'https://example.com/kimi-ref',
  }])
  assert.match(output.join(''), /带引用的回答。/)
})

test('Kimi non-stream collects search artifacts from web_search tool blocks', async () => {
  const handler = new KimiStreamHandler('kimi-k2.6', 'session-tool')
  const source = grpcFrames([
    { chat: { id: 'chat-tool' } },
    {
      message: {
        id: 'user-tool',
        role: 'user',
      },
    },
    {
      message: {
        id: 'assistant-tool',
        role: 'assistant',
      },
    },
    {
      op: 'append',
      mask: 'block.tool.args',
      block: { id: '1', tool: { args: '{"queries":["' } },
    },
    {
      op: 'append',
      mask: 'block.tool.args',
      block: { id: '1', tool: { args: '夏天防晒 2026' } },
    },
    {
      op: 'append',
      mask: 'block.tool.args',
      block: { id: '1', tool: { args: '"],"related_questions":["夏天户外怎么补防晒？"]}' } },
    },
    {
      op: 'append',
      mask: 'block.tool.contents',
      block: {
        id: '1',
        tool: {
          contents: [{
            searchResult: {
              id: '1',
              base: {
                title: '2026 防晒推荐',
                url: 'https://example.com/sunscreen',
                siteName: 'Example Beauty',
                snippet: '防晒霜和物理防晒建议。',
              },
              refIndex: 'web_search:1#0',
            },
          }],
        },
      },
    },
    {
      op: 'append',
      mask: 'block.text.content',
      block: { text: { content: '夏天防晒建议如下。' } },
    },
    { done: {} },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.id, 'chat-tool')
  assert.equal(response.choices[0].message.content, '夏天防晒建议如下。')
  assert.deepEqual(response.choices[0].message.search_results.keywords, ['夏天防晒 2026'])
  assert.deepEqual(response.choices[0].message.search_queries, ['夏天防晒 2026'])
  assert.deepEqual(response.choices[0].message.related_searches, ['夏天户外怎么补防晒？'])
  assert.deepEqual(response.choices[0].message.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
    siteName: citation.siteName,
  })), [{
    index: 1,
    title: '2026 防晒推荐',
    url: 'https://example.com/sunscreen',
    siteName: 'Example Beauty',
  }])
  assert.deepEqual(handler.getMessageIds(), ['assistant-tool', 'user-tool'])
})

test('Kimi stream attaches chat2api share metadata to final chunk', async () => {
  const handler = new KimiStreamHandler(
    'kimi-k2.6',
    'session-share',
    false,
    undefined,
    async (context) => ({
      provider: 'kimi',
      chat_id: context.chat_id || 'chat-share',
      message_id: context.message_id,
      message_ids: context.message_ids,
      conversation_url: `https://www.kimi.com/chat/${context.chat_id}`,
      share_id: 'share-123',
      share_url: 'https://www.kimi.com/share/share-123',
      citations: context.citations,
      search_results: context.search_results,
      search_queries: context.search_queries,
      related_searches: context.related_searches,
    })
  )
  const source = grpcFrames([
    { chat: { id: 'chat-share' } },
    {
      message: {
        id: 'user-share',
        role: 'user',
      },
    },
    {
      message: {
        id: 'assistant-share',
        role: 'assistant',
        blocks: [{
          content: {
            case: 'search',
            value: {
              keywords: ['GEO优化公司推荐'],
              relatedQuestions: ['GEO 优化怎么做？'],
              webPages: [{
                title: 'GEO 公司榜单',
                url: 'https://example.com/share-ref',
              }],
            },
          },
        }],
      },
    },
    {
      op: 'append',
      mask: 'block.text.content',
      block: { text: { content: '带分享链接的回答。' } },
    },
    { done: {} },
  ])

  const output = await collect(await handler.handleStream(source))
  const events = output
    .join('')
    .split('\n\n')
    .filter(Boolean)
  const doneIndex = events.findIndex(event => event === 'data: [DONE]')
  const finalChunk = JSON.parse(events[doneIndex - 1].slice('data: '.length))

  assert.equal(finalChunk.chat2api.provider, 'kimi')
  assert.equal(finalChunk.chat2api.chat_id, 'chat-share')
  assert.equal(finalChunk.chat2api.message_id, 'assistant-share')
  assert.deepEqual(finalChunk.chat2api.message_ids, ['assistant-share', 'user-share'])
  assert.equal(finalChunk.chat2api.conversation_url, 'https://www.kimi.com/chat/chat-share')
  assert.equal(finalChunk.chat2api.share_url, 'https://www.kimi.com/share/share-123')
  assert.deepEqual(finalChunk.chat2api.search_results.keywords, ['GEO优化公司推荐'])
  assert.deepEqual(finalChunk.chat2api.search_queries, ['GEO优化公司推荐'])
  assert.deepEqual(finalChunk.chat2api.related_searches, ['GEO 优化怎么做？'])
  assert.deepEqual(finalChunk.chat2api.citations.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [{
    index: 1,
    title: 'GEO 公司榜单',
    url: 'https://example.com/share-ref',
  }])
})

test('Kimi non-stream collects search artifacts from message blocks', async () => {
  const handler = new KimiStreamHandler('kimi-k2.6', 'session-blocks')
  const source = grpcFrames([
    {
      chat: { id: 'chat-blocks' },
      message: {
        id: 'assistant-blocks',
        role: 'assistant',
        blocks: [{
          content: {
            case: 'search',
            value: {
              keyword: { text: 'GEO 公司选择' },
              suggestedQuestions: [{ question: 'GEO 公司怎么选？' }],
              pages: [{
                index: '3',
                base: {
                  title: 'GEO 服务案例',
                  sourceUrl: 'https://example.com/case',
                  summary: 'GEO 服务商案例与结果。',
                  site_name: 'Case Site',
                },
              }],
              steps: [{
                queries: [{ query: 'GEO 优化服务商报价' }],
                followUpQuestions: ['GEO 报价一般多少？'],
                results: [{
                  title: 'GEO 报价参考',
                  link: 'https://example.com/price',
                }],
              }],
            },
          },
        }],
      },
    },
    {
      op: 'append',
      mask: 'block.text.content',
      block: { text: { content: '这些公司可以优先看案例。' } },
    },
    { done: {} },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.id, 'chat-blocks')
  assert.deepEqual(response.choices[0].message.search_results.keywords, [
    'GEO 公司选择',
    'GEO 优化服务商报价',
  ])
  assert.deepEqual(response.choices[0].message.search_queries, [
    'GEO 公司选择',
    'GEO 优化服务商报价',
  ])
  assert.deepEqual(response.choices[0].message.related_searches, [
    'GEO 公司怎么选？',
    'GEO 报价一般多少？',
  ])
  assert.deepEqual(response.choices[0].message.search_results.webPages.map((citation: any) => ({
    index: citation.index,
    title: citation.title,
    url: citation.url,
  })), [
    {
      index: 1,
      title: 'GEO 报价参考',
      url: 'https://example.com/price',
    },
    {
      index: 3,
      title: 'GEO 服务案例',
      url: 'https://example.com/case',
    },
  ])
})
