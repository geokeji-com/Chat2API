import test from 'node:test'
import assert from 'node:assert/strict'

import type { Account, Provider, ProxyNode } from '../../src/main/store/types.ts'
import type { GatewayChatTask } from '../../src/shared/gatewayWorker.ts'
import {
  GatewayTaskPool,
  GatewayTaskRunner,
  InMemoryGatewayClient,
  createWorkerRegistration,
  selectWorkerAccount,
  type GatewayChatTaskExecutor,
  type WorkerAccountSelection,
} from '../../src/main/worker/index.ts'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://chat.deepseek.com',
    headers: {},
    enabled: true,
    supportedModels: ['deepseek-v4-flash'],
    modelMappings: {
      'deepseek-v4-flash-search': 'deepseek-v4-flash',
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    providerId: 'deepseek',
    name: id,
    credentials: {},
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    todayUsed: 0,
    ...overrides,
  }
}

function proxyNode(id: string, overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    id,
    name: id,
    host: `${id}.example.test`,
    port: 1080,
    enabled: true,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function task(id: string, overrides: Partial<GatewayChatTask> = {}): GatewayChatTask {
  return {
    task_id: id,
    type: 'chat_completion',
    priority: 1,
    platform: {
      provider_id: 'deepseek',
      model: 'deepseek-v4-flash-search',
    },
    target: {
      country: 'CN',
      province: '陕西',
      city: '西安',
      region_code: 'ZH-610100',
    },
    mode: {
      stream: true,
      web_search: true,
      thinking: false,
      include_final_response: true,
      share: true,
    },
    input: {
      messages: [
        { role: 'user', content: '西安夏天户外防晒推荐' },
      ],
    },
    output: {
      format: 'structured_answer',
      required_fields: ['content', 'citations', 'share_url'],
    },
    ...overrides,
  }
}

test('selects a required city account for the requested provider and model', () => {
  const selected = selectWorkerAccount({
    task: task('t1', {
      account_scope: {
        province: '陕西省',
        city: '西安市',
        region_code: '610100',
        match_policy: 'required',
      },
    }),
    providers: [provider()],
    accounts: [
      account('a-hz', {
        featureConfig: {
          worker: {
            location: { province: '浙江', city: '杭州', regionCode: 'ZH-330100' },
          },
        },
      }),
      account('a-xa', {
        featureConfig: {
          worker: {
            location: { province: '陕西', city: '西安', regionCode: 'ZH-610100' },
            tags: ['local-search'],
          },
        },
      }),
    ],
  })

  assert.equal(selected?.account.id, 'a-xa')
  assert.equal(selected?.actualModel, 'deepseek-v4-flash')
  assert.equal(selected?.accountContext.city, '西安')
  assert.equal(selected?.accountContext.region_code, 'ZH-610100')
})

test('falls back to bound proxy city when account worker location is not set', () => {
  const selected = selectWorkerAccount({
    task: task('t2', {
      account_scope: {
        city: '杭州',
        match_policy: 'required',
      },
    }),
    providers: [provider()],
    accounts: [
      account('a-proxy', {
        proxyBinding: { proxyId: 'p-hz' },
      }),
    ],
    proxyNodes: [
      proxyNode('p-hz', { province: '浙江', city: '杭州', regionCode: 'ZH-330100' }),
    ],
  })

  assert.equal(selected?.account.id, 'a-proxy')
  assert.equal(selected?.accountContext.location_source, 'proxy_binding')
  assert.equal(selected?.accountContext.proxy_id, 'p-hz')
})

test('required city mismatch produces no account while preferred city keeps a warning', () => {
  const providers = [provider()]
  const accounts = [
    account('a-hz', {
      featureConfig: {
        worker: {
          location: { province: '浙江', city: '杭州', regionCode: 'ZH-330100' },
        },
      },
    }),
  ]

  assert.equal(selectWorkerAccount({
    task: task('t3', {
      account_scope: { city: '西安', match_policy: 'required' },
    }),
    providers,
    accounts,
  }), null)

  const preferred = selectWorkerAccount({
    task: task('t4', {
      account_scope: { city: '西安', match_policy: 'preferred' },
    }),
    providers,
    accounts,
  })

  assert.equal(preferred?.account.id, 'a-hz')
  assert.deepEqual(preferred?.warnings, ['preferred_account_location_not_matched'])
})

test('worker registration publishes provider models and account locations without credentials', () => {
  const registration = createWorkerRegistration({
    workerId: 'worker-local-1',
    name: 'Local Worker',
    version: '1.4.0',
    providers: [provider()],
    accounts: [
      account('a-xa', {
        credentials: { token: 'secret-token' },
        featureConfig: {
          worker: {
            location: { province: '陕西', city: '西安', regionCode: 'ZH-610100' },
            maxConcurrency: 2,
          },
        },
      }),
    ],
    maxCachedTasks: 4,
    maxTaskTimeoutMs: 300000,
  })

  assert.equal(registration.worker_id, 'worker-local-1')
  assert.deepEqual(registration.capabilities[0].models, [
    'deepseek-v4-flash',
    'deepseek-v4-flash-search',
  ])
  assert.deepEqual(registration.capabilities[0].account_locations, [
    { province: '陕西', city: '西安', region_code: 'ZH-610100' },
  ])
  assert.equal(JSON.stringify(registration).includes('secret-token'), false)
})

test('task pool leases a small priority ordered cache from mock gateway', async () => {
  const gateway = new InMemoryGatewayClient([
    task('low', { priority: 1, created_at: '2026-06-10T00:00:00.000Z' }),
    task('high', { priority: 10, created_at: '2026-06-10T00:00:01.000Z' }),
    task('middle', { priority: 5, created_at: '2026-06-10T00:00:02.000Z' }),
  ])
  const pool = new GatewayTaskPool({
    gateway,
    workerId: 'worker-local-1',
    maxCachedTasks: 2,
  })

  assert.equal(await pool.refill(), 2)
  assert.equal(pool.size(), 2)
  assert.equal((await pool.nextTask())?.task_id, 'high')
  assert.equal((await pool.nextTask())?.task_id, 'middle')
  assert.equal(gateway.getTaskStates().filter(state => state.status === 'leased').length, 2)
})

test('runner submits structured content citations and share url', async () => {
  const gateway = new InMemoryGatewayClient()
  const leasedTask = task('t5', {
    account_scope: {
      city: '西安',
      match_policy: 'required',
    },
    lease: {
      attempt_id: 'attempt-1',
    },
  })
  gateway.addTask(leasedTask)
  const fakeExecutor: GatewayChatTaskExecutor = {
    async execute(_task: GatewayChatTask, _selection: WorkerAccountSelection) {
      return {
        response: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '最终答案',
              citations: [{ title: '来源', url: 'https://example.test' }],
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          chat2api: {
            share_url: 'https://chat.deepseek.com/share/mock',
            session_id: 'session-1',
          },
        },
      }
    },
  }
  const runner = new GatewayTaskRunner({
    workerId: 'worker-local-1',
    gateway,
    providers: () => [provider()],
    accounts: () => [
      account('a-xa', {
        featureConfig: {
          worker: {
            location: { province: '陕西', city: '西安', regionCode: 'ZH-610100' },
          },
        },
      }),
    ],
    executor: fakeExecutor,
  })

  const outcome = await runner.runTask(leasedTask)

  assert.equal(outcome.status, 'completed')
  assert.equal(gateway.getSubmittedResults()[0].result.content, '最终答案')
  assert.equal(gateway.getSubmittedResults()[0].result.reasoning_content, '')
  assert.deepEqual(gateway.getSubmittedResults()[0].result.search_queries, [])
  assert.equal(gateway.getSubmittedResults()[0].result.related_searches, '')
  assert.equal(gateway.getSubmittedResults()[0].result.share_url, 'https://chat.deepseek.com/share/mock')
  assert.equal(gateway.getSubmittedResults()[0].account_context.account_id, 'a-xa')
})

test('runner submits reasoning content when thinking is enabled', async () => {
  const gateway = new InMemoryGatewayClient()
  const leasedTask = task('t-thinking', {
    mode: {
      stream: true,
      web_search: false,
      thinking: true,
      include_final_response: true,
    },
    lease: {
      attempt_id: 'attempt-thinking',
    },
  })
  gateway.addTask(leasedTask)

  const runner = new GatewayTaskRunner({
    workerId: 'worker-local-1',
    gateway,
    providers: () => [provider()],
    accounts: () => [
      account('a-xa', {
        featureConfig: {
          worker: {
            location: { province: '陕西', city: '西安', regionCode: 'ZH-610100' },
          },
        },
      }),
    ],
    executor: {
      async execute() {
        return {
          response: {
            id: 'chatcmpl-thinking',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [{
              index: 0,
            message: {
              role: 'assistant',
              reasoning_content: '先分析用户场景。',
              content: '最终答案',
              search_queries: ['户外防晒推荐'],
              related_searches: [{ question: '夏天户外怎么补防晒？' }],
            },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        }
      },
    },
  })

  const outcome = await runner.runTask(leasedTask)

  assert.equal(outcome.status, 'completed')
  assert.equal(gateway.getSubmittedResults()[0].result.content, '最终答案')
  assert.equal(gateway.getSubmittedResults()[0].result.reasoning_content, '先分析用户场景。')
  assert.deepEqual(gateway.getSubmittedResults()[0].result.search_queries, ['户外防晒推荐'])
  assert.deepEqual(gateway.getSubmittedResults()[0].result.related_searches, ['夏天户外怎么补防晒？'])
})

test('runner submits non-retryable failure when no city account is available', async () => {
  const gateway = new InMemoryGatewayClient()
  const leasedTask = task('t6', {
    account_scope: {
      city: '西安',
      match_policy: 'required',
    },
    lease: {
      attempt_id: 'attempt-2',
    },
  })
  gateway.addTask(leasedTask)
  const runner = new GatewayTaskRunner({
    workerId: 'worker-local-1',
    gateway,
    providers: () => [provider()],
    accounts: () => [
      account('a-hz', {
        featureConfig: {
          worker: {
            location: { province: '浙江', city: '杭州', regionCode: 'ZH-330100' },
          },
        },
      }),
    ],
    executor: {
      async execute() {
        throw new Error('should not execute')
      },
    },
  })

  const outcome = await runner.runTask(leasedTask)

  assert.equal(outcome.status, 'failed')
  assert.equal(gateway.getSubmittedFailures()[0].error.code, 'NO_AVAILABLE_ACCOUNT')
  assert.equal(gateway.getSubmittedFailures()[0].error.retryable, false)
})
