import type {
  GatewayHeartbeat,
  WorkerRegistration,
} from '../../shared/gatewayWorker.ts'
import type { GatewayClient } from './gatewayClient.ts'
import { GatewayTaskPool } from './taskPool.ts'
import { GatewayTaskRunner } from './taskRunner.ts'
import type { GatewayTaskRunOutcome } from './taskRunner.ts'

export interface GatewayWorkerServiceOptions {
  registration: WorkerRegistration
  gateway: GatewayClient
  pool: GatewayTaskPool
  runner: GatewayTaskRunner
  heartbeatIntervalMs?: number
  concurrency?: number
}

export class GatewayWorkerService {
  private readonly registration: WorkerRegistration
  private readonly gateway: GatewayClient
  private readonly pool: GatewayTaskPool
  private readonly runner: GatewayTaskRunner
  private readonly concurrency: number
  private heartbeatIntervalMs: number
  private heartbeatTimer: NodeJS.Timeout | undefined
  private activeTasks = 0
  private running = false

  constructor(options: GatewayWorkerServiceOptions) {
    this.registration = options.registration
    this.gateway = options.gateway
    this.pool = options.pool
    this.runner = options.runner
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000
    this.concurrency = Math.max(1, options.concurrency || 1)
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    const ack = await this.gateway.registerWorker(this.registration)
    if (!ack.accepted) {
      throw new Error(ack.message || 'Gateway rejected worker registration')
    }

    this.running = true
    this.heartbeatIntervalMs = ack.heartbeat_interval_ms || this.heartbeatIntervalMs
    await this.sendHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat()
    }, this.heartbeatIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    await this.sendHeartbeat()
  }

  async processAvailable(): Promise<GatewayTaskRunOutcome[]> {
    if (!this.running) {
      throw new Error('Gateway worker is not running')
    }

    await this.pool.refill()
    const capacity = Math.max(0, this.concurrency - this.activeTasks)
    const outcomes: GatewayTaskRunOutcome[] = []

    for (let index = 0; index < capacity; index += 1) {
      const task = await this.pool.nextTask()
      if (!task) {
        break
      }

      this.activeTasks += 1
      try {
        outcomes.push(await this.runner.runTask(task))
      } finally {
        this.activeTasks -= 1
      }
    }

    return outcomes
  }

  getStatus(): GatewayHeartbeat {
    return {
      worker_id: this.registration.worker_id,
      active_tasks: this.activeTasks,
      cached_tasks: this.pool.size(),
      timestamp: new Date().toISOString(),
    }
  }

  private async sendHeartbeat(): Promise<void> {
    await this.gateway.heartbeat(this.getStatus())
  }
}
