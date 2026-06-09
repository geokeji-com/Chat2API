import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDeepSeekPostShareFollowUpPlan,
  executeDeepSeekPostShareFollowUps,
  resolveDeepSeekPostShareFollowUpConfig,
} from '../../src/main/proxy/services/deepseekPostShareFollowUp.ts'
import {
  buildDeepSeekFollowUpFeatureConfig,
  removeDeepSeekFollowUpFeatureConfig,
} from '../../src/shared/deepseekFollowUp.ts'
import type { DeepSeekMessageId, DeepSeekShareInfo } from '../../src/main/proxy/adapters/deepseek.ts'
import type { Account } from '../../src/shared/types.ts'

const enabledConfig = {
  enabled: true,
  prompts: ['能不能再具体展开一下？', '有没有实际案例或注意事项？'],
  delayMs: 1500,
}

const shareInfo: DeepSeekShareInfo = {
  provider: 'deepseek',
  session_id: 'session-share',
  message_id: 'assistant-main',
  message_ids: ['user-main', 'assistant-main'],
  conversation_url: 'https://chat.deepseek.com/a/chat/s/session-share',
  share_id: 'share-123',
  share_url: 'https://chat.deepseek.com/share/share-123',
}

const baseAccount: Pick<Account, 'featureConfig'> = {}

test('DeepSeek post-share follow-up plan is created only after share URL exists', () => {
  const plan = createDeepSeekPostShareFollowUpPlan({
    config: enabledConfig,
    shareInfo,
    finishReason: 'stop',
  })

  assert.deepEqual(plan, {
    initialParentMessageId: 'assistant-main',
    prompts: enabledConfig.prompts,
    delayMs: 1500,
  })
})

test('DeepSeek post-share follow-up plan is disabled by config', () => {
  const plan = createDeepSeekPostShareFollowUpPlan({
    config: {
      ...enabledConfig,
      enabled: false,
    },
    shareInfo,
    finishReason: 'stop',
  })

  assert.equal(plan, undefined)
})

test('DeepSeek post-share follow-up config uses app default without account override', () => {
  const config = resolveDeepSeekPostShareFollowUpConfig({
    defaultConfig: enabledConfig,
    account: baseAccount,
  })

  assert.deepEqual(config, enabledConfig)
})

test('DeepSeek post-share follow-up config uses account override when enabled', () => {
  const accountConfig = {
    enabled: true,
    prompts: ['第一轮账号追问', '第二轮账号追问'],
    delayMs: 600,
  }

  const config = resolveDeepSeekPostShareFollowUpConfig({
    defaultConfig: {
      ...enabledConfig,
      enabled: false,
    },
    account: {
      featureConfig: {
        deepSeekPostShareFollowUp: accountConfig,
      },
    },
  })

  assert.deepEqual(config, accountConfig)
})

test('DeepSeek post-share follow-up account override can disable default config', () => {
  const config = resolveDeepSeekPostShareFollowUpConfig({
    defaultConfig: enabledConfig,
    account: {
      featureConfig: {
        deepSeekPostShareFollowUp: {
          ...enabledConfig,
          enabled: false,
        },
      },
    },
  })

  const plan = createDeepSeekPostShareFollowUpPlan({
    config,
    shareInfo,
    finishReason: 'stop',
  })

  assert.equal(plan, undefined)
})

test('DeepSeek post-share follow-up plan is not created without share URL', () => {
  const plan = createDeepSeekPostShareFollowUpPlan({
    config: enabledConfig,
    shareInfo: {
      ...shareInfo,
      share_url: undefined,
      share_error: 'share failed',
    },
    finishReason: 'stop',
  })

  assert.equal(plan, undefined)
})

test('DeepSeek post-share follow-up plan skips tool call intermediate responses', () => {
  const plan = createDeepSeekPostShareFollowUpPlan({
    config: enabledConfig,
    shareInfo,
    finishReason: 'tool_calls',
  })

  assert.equal(plan, undefined)
})

test('DeepSeek post-share follow-up plan requires exactly two prompts', () => {
  const plan = createDeepSeekPostShareFollowUpPlan({
    config: {
      ...enabledConfig,
      prompts: ['只追问一轮'],
    },
    shareInfo,
    finishReason: 'stop',
  })

  assert.equal(plan, undefined)
})

test('DeepSeek post-share follow-ups use chained parent message IDs', async () => {
  const calls: Array<{
    sessionId: string
    parentMessageId: DeepSeekMessageId
    prompt: string
    model: string
  }> = []
  const nextIds = ['assistant-follow-1', 'assistant-follow-2']

  const responseMessageIds = await executeDeepSeekPostShareFollowUps({
    sessionId: 'session-share',
    model: 'deepseek-v4-flash',
    initialParentMessageId: 'assistant-main',
    prompts: enabledConfig.prompts,
    delayMs: 1500,
    wait: async (delayMs) => {
      assert.equal(delayMs, 1500)
    },
    sendFollowUp: async (sessionId, parentMessageId, prompt, model) => {
      calls.push({ sessionId, parentMessageId, prompt, model })
      return nextIds[calls.length - 1]
    },
  })

  assert.deepEqual(responseMessageIds, nextIds)
  assert.deepEqual(calls, [
    {
      sessionId: 'session-share',
      parentMessageId: 'assistant-main',
      prompt: '能不能再具体展开一下？',
      model: 'deepseek-v4-flash',
    },
    {
      sessionId: 'session-share',
      parentMessageId: 'assistant-follow-1',
      prompt: '有没有实际案例或注意事项？',
      model: 'deepseek-v4-flash',
    },
  ])
})

test('DeepSeek post-share follow-up planning does not mutate shared message IDs', () => {
  const originalMessageIds = [...shareInfo.message_ids!]

  createDeepSeekPostShareFollowUpPlan({
    config: enabledConfig,
    shareInfo,
    finishReason: 'stop',
  })

  assert.deepEqual(shareInfo.message_ids, originalMessageIds)
})

test('DeepSeek follow-up batch config payload contains all override fields', () => {
  const config = {
    enabled: true,
    prompts: ['批量第一轮', '批量第二轮'],
    delayMs: 3000,
  }

  const featureConfig = buildDeepSeekFollowUpFeatureConfig(
    {
      otherFeature: true,
    } as any,
    config,
  )

  assert.deepEqual(featureConfig.deepSeekPostShareFollowUp, config)
  assert.equal((featureConfig as any).otherFeature, true)
})

test('DeepSeek follow-up restore inherit removes only account override', () => {
  const featureConfig = removeDeepSeekFollowUpFeatureConfig({
    deepSeekPostShareFollowUp: enabledConfig,
    otherFeature: true,
  } as any)

  assert.deepEqual(featureConfig, {
    otherFeature: true,
  })

  const emptyFeatureConfig = removeDeepSeekFollowUpFeatureConfig({
    deepSeekPostShareFollowUp: enabledConfig,
  })

  assert.equal(emptyFeatureConfig, undefined)
})
