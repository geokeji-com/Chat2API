import test from 'node:test'
import assert from 'node:assert/strict'

import { RequestClassifier } from '../../src/main/rpa/requestClassifier.ts'
import type { RpaCapturedRequest, RpaTarget } from '../../src/shared/rpa.ts'

const target: RpaTarget = {
  id: 'target-1',
  type: 'page',
  title: 'DeepSeek',
  url: 'https://chat.deepseek.com/a/chat/s/session-1',
}

function request(overrides: Partial<RpaCapturedRequest>): RpaCapturedRequest {
  return {
    id: overrides.id || `${overrides.method || 'POST'}:${overrides.url || 'https://chat.deepseek.com/api/v0/chat/completion'}`,
    url: overrides.url || 'https://chat.deepseek.com/api/v0/chat/completion',
    method: overrides.method || 'POST',
    resourceType: overrides.resourceType || 'XHR',
    lifecycle: overrides.lifecycle || 'completed',
    status: overrides.status || 200,
    mimeType: overrides.mimeType || 'application/json',
    requestHeaders: overrides.requestHeaders || { authorization: '[REDACTED]' },
    responseHeaders: overrides.responseHeaders || {},
    requestBody: overrides.requestBody,
    responseBody: overrides.responseBody,
    startedAt: overrides.startedAt || Date.now(),
    endedAt: overrides.endedAt,
    isEventStream: overrides.isEventStream,
    bodyTruncated: overrides.bodyTruncated,
    error: overrides.error,
  }
}

test('RPA classifier separates DeepSeek chat, session, share, and PoW endpoints', () => {
  const classifier = new RequestClassifier()
  const result = classifier.classify({
    sessionId: 'rpa-session',
    target,
    requests: [
      request({
        id: 'chat:completed',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        mimeType: 'text/event-stream',
        isEventStream: true,
        requestBody: JSON.stringify({
          chat_session_id: 'session-1',
          parent_message_id: 4,
          model_type: null,
          prompt: '展开说说',
          ref_file_ids: [],
          thinking_enabled: false,
          search_enabled: true,
          action: null,
          preempt: false,
        }),
        responseBody: 'event: ready\ndata: {"request_message_id":5,"response_message_id":6,"model_type":"default"}',
      }),
      request({
        id: 'session:completed',
        url: 'https://chat.deepseek.com/api/v0/chat_session/create',
        requestBody: '{}',
        responseBody: JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              chat_session: {
                id: 'session-created',
                agent: 'chat',
                model_type: 'default',
                title_type: 'WIP',
              },
            },
          },
        }),
      }),
      request({
        id: 'pow:completed',
        url: 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge',
        requestBody: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        responseBody: JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'abc',
                salt: 'salt',
                signature: 'signature',
                target_path: '/api/v0/chat/completion',
              },
            },
          },
        }),
      }),
      request({
        id: 'share:completed',
        url: 'https://chat.deepseek.com/api/v0/share/create',
        requestBody: JSON.stringify({
          chat_session_id: 'session-1',
          message_ids: [5, 6],
        }),
        responseBody: JSON.stringify({
          code: 0,
          data: {
            biz_data: {
              share_id: 'share-123',
            },
          },
        }),
      }),
    ],
  })

  assert.equal(result.primaryChat?.path, '/api/v0/chat/completion')

  const findingsByPath = Object.fromEntries(result.findings.map((finding) => [finding.path, finding]))
  assert.equal(findingsByPath['/api/v0/chat/completion'].kind, 'chat')
  assert.equal(findingsByPath['/api/v0/chat_session/create'].kind, 'session')
  assert.deepEqual(findingsByPath['/api/v0/chat_session/create'].models, [])
  assert.equal(findingsByPath['/api/v0/chat/create_pow_challenge'].kind, 'pow/challenge')
  assert.deepEqual(findingsByPath['/api/v0/chat/create_pow_challenge'].models, [])
  assert.equal(findingsByPath['/api/v0/share/create'].kind, 'share')
  assert.deepEqual(findingsByPath['/api/v0/share/create'].models, [])
})
