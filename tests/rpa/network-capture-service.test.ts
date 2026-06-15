import test from 'node:test'
import assert from 'node:assert/strict'

import { NetworkCaptureService } from '../../src/main/rpa/networkCaptureService.ts'
import {
  getRpaLearningTargetForProvider,
  type RpaTarget,
} from '../../src/shared/rpa.ts'

const target: RpaTarget = {
  id: 'target-1',
  type: 'page',
  title: 'DeepSeek',
  url: 'https://chat.deepseek.com/',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-1',
}

test('network capture tolerates omitted capture domains', () => {
  assert.doesNotThrow(() => new NetworkCaptureService(target))
  assert.doesNotThrow(() => new NetworkCaptureService(target, {}))
  assert.doesNotThrow(() => new NetworkCaptureService(target, { captureDomains: undefined }))
})

test('DeepSeek has an RPA learning target with capture domains', () => {
  const learningTarget = getRpaLearningTargetForProvider('deepseek')

  assert.equal(learningTarget?.url, 'https://chat.deepseek.com/')
  assert.deepEqual(learningTarget?.captureDomains, ['deepseek.com'])
})

test('all provider recording paths tolerate missing RPA capture domain presets', () => {
  const providerUrls: Array<[string, string]> = [
    ['deepseek', 'https://chat.deepseek.com/'],
    ['doubao', 'https://www.doubao.com/chat/'],
    ['yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa'],
    ['kimi', 'https://www.kimi.com/'],
    ['qwen', 'https://www.qianwen.com/'],
    ['glm', 'https://chatglm.cn/'],
    ['minimax', 'https://agent.minimaxi.com/'],
    ['mimo', 'https://aistudio.xiaomimimo.com/'],
    ['perplexity', 'https://www.perplexity.ai/'],
    ['qwen-ai', 'https://chat.qwen.ai/'],
    ['zai', 'https://chat.z.ai/'],
    ['custom', 'https://example.com/chat'],
  ]

  for (const [providerId, url] of providerUrls) {
    const learningTarget = getRpaLearningTargetForProvider(providerId)

    assert.doesNotThrow(
      () => new NetworkCaptureService(
        { ...target, id: providerId, title: providerId, url },
        { captureDomains: learningTarget?.captureDomains },
      ),
      providerId,
    )
  }
})
