import type { GatewayChatTask, WorkerCapability } from '../../shared/gatewayWorker.ts'
import type { GatewayClient } from './gatewayClient.ts'

export interface GatewayTaskPoolOptions {
  gateway: GatewayClient
  workerId: string
  maxCachedTasks: number
  capabilities?: WorkerCapability[]
}

export class GatewayTaskPool {
  private readonly gateway: GatewayClient
  private readonly workerId: string
  private readonly maxCachedTasks: number
  private readonly capabilities?: WorkerCapability[]
  private cache: GatewayChatTask[] = []

  constructor(options: GatewayTaskPoolOptions) {
    this.gateway = options.gateway
    this.workerId = options.workerId
    this.maxCachedTasks = Math.max(1, options.maxCachedTasks)
    this.capabilities = options.capabilities
  }

  size(): number {
    return this.cache.length
  }

  snapshot(): GatewayChatTask[] {
    return this.cache.map(task => ({ ...task }))
  }

  async refill(): Promise<number> {
    const missing = this.maxCachedTasks - this.cache.length
    if (missing <= 0) {
      return 0
    }

    const batch = await this.gateway.leaseTasks({
      worker_id: this.workerId,
      max_tasks: missing,
      capabilities: this.capabilities,
    })

    this.cache = [...this.cache, ...batch.tasks]
    return batch.tasks.length
  }

  async nextTask(): Promise<GatewayChatTask | null> {
    if (this.cache.length === 0) {
      await this.refill()
    }

    const [next, ...rest] = this.cache
    this.cache = rest
    return next || null
  }

  clear(): void {
    this.cache = []
  }
}
