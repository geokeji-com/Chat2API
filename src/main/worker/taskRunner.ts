import type { Account, Provider, ProxyNode } from '../store/types.ts'
import type { GatewayChatTask, GatewayTaskFailure, GatewayTaskResult } from '../../shared/gatewayWorker.ts'
import type { GatewayClient } from './gatewayClient.ts'
import { selectWorkerAccount } from './accountSelector.ts'
import type { GatewayChatTaskExecutor } from './executorTypes.ts'
import { buildTaskFailure, buildTaskResult } from './taskResult.ts'

export interface GatewayTaskRunnerOptions {
  workerId: string
  gateway: GatewayClient
  providers: () => Provider[]
  accounts: () => Account[]
  proxyNodes?: () => ProxyNode[]
  executor?: GatewayChatTaskExecutor
}

export interface GatewayTaskRunOutcome {
  taskId: string
  status: 'completed' | 'failed'
  result?: GatewayTaskResult
  failure?: GatewayTaskFailure
}

export class GatewayTaskRunner {
  private readonly workerId: string
  private readonly gateway: GatewayClient
  private readonly providers: () => Provider[]
  private readonly accounts: () => Account[]
  private readonly proxyNodes: () => ProxyNode[]
  private readonly executor?: GatewayChatTaskExecutor

  constructor(options: GatewayTaskRunnerOptions) {
    this.workerId = options.workerId
    this.gateway = options.gateway
    this.providers = options.providers
    this.accounts = options.accounts
    this.proxyNodes = options.proxyNodes || (() => [])
    this.executor = options.executor
  }

  async runTask(task: GatewayChatTask): Promise<GatewayTaskRunOutcome> {
    const startedAt = new Date()
    const selection = selectWorkerAccount({
      task,
      providers: this.providers(),
      accounts: this.accounts(),
      proxyNodes: this.proxyNodes(),
    })

    if (!selection) {
      const failure = buildTaskFailure({
        task,
        workerId: this.workerId,
        error: new Error(`No available account for ${task.platform.provider_id}/${task.platform.model}`),
        startedAt,
        failedAt: new Date(),
        code: 'NO_AVAILABLE_ACCOUNT',
        retryable: false,
        details: {
          provider_id: task.platform.provider_id,
          model: task.platform.model,
          account_scope: task.account_scope,
        },
      })
      await this.gateway.submitFailure(failure)
      return { taskId: task.task_id, status: 'failed', failure }
    }

    try {
      const executor = await this.getExecutor()
      const output = await executor.execute(task, selection)
      const completedAt = new Date()
      const result = buildTaskResult({
        task,
        workerId: this.workerId,
        accountContext: selection.accountContext,
        output,
        startedAt,
        completedAt,
      })
      await this.gateway.submitResult(result)
      return { taskId: task.task_id, status: 'completed', result }
    } catch (error) {
      const failedAt = new Date()
      const failure = buildTaskFailure({
        task,
        workerId: this.workerId,
        accountContext: selection.accountContext,
        error,
        startedAt,
        failedAt,
      })
      await this.gateway.submitFailure(failure)
      return { taskId: task.task_id, status: 'failed', failure }
    }
  }

  private async getExecutor(): Promise<GatewayChatTaskExecutor> {
    if (this.executor) {
      return this.executor
    }

    const module = await import('./taskExecutor.ts')
    return new module.ForwarderTaskExecutor()
  }
}
