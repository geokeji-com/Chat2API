import { randomUUID } from 'node:crypto'
import type {
  GatewayChatTask,
  GatewayHeartbeat,
  GatewayRegistrationAck,
  GatewayTaskFailure,
  GatewayTaskLeaseBatch,
  GatewayTaskLeaseRequest,
  GatewayTaskResult,
  GatewayTaskStatus,
  WorkerRegistration,
} from '../../shared/gatewayWorker.ts'
import type { GatewayClient } from './gatewayClient.ts'

interface MockTaskState {
  task: GatewayChatTask
  status: GatewayTaskStatus
  leasedBy?: string
  attemptId?: string
  leasedUntil?: string
  result?: GatewayTaskResult
  failure?: GatewayTaskFailure
}

export class InMemoryGatewayClient implements GatewayClient {
  private registration: WorkerRegistration | undefined
  private readonly tasks = new Map<string, MockTaskState>()
  private readonly heartbeats: GatewayHeartbeat[] = []

  constructor(seedTasks: GatewayChatTask[] = []) {
    for (const task of seedTasks) {
      this.addTask(task)
    }
  }

  addTask(task: GatewayChatTask): void {
    this.tasks.set(task.task_id, {
      task: clone(task),
      status: 'queued',
    })
  }

  async registerWorker(registration: WorkerRegistration): Promise<GatewayRegistrationAck> {
    this.registration = clone(registration)
    return {
      accepted: true,
      worker_id: registration.worker_id,
      server_time: new Date().toISOString(),
      heartbeat_interval_ms: 30000,
      message: 'mock gateway accepted worker',
    }
  }

  async heartbeat(heartbeat: GatewayHeartbeat): Promise<void> {
    this.heartbeats.push(clone(heartbeat))
  }

  async leaseTasks(request: GatewayTaskLeaseRequest): Promise<GatewayTaskLeaseBatch> {
    const now = Date.now()
    const leaseTimeoutMs = 5 * 60 * 1000
    const leaseCandidates = [...this.tasks.values()]
      .filter(state => state.status === 'queued')
      .sort((a, b) => {
        const priorityDiff = (b.task.priority || 0) - (a.task.priority || 0)
        if (priorityDiff !== 0) return priorityDiff
        return (a.task.created_at || '').localeCompare(b.task.created_at || '')
      })
      .slice(0, Math.max(0, request.max_tasks))

    const leasedTasks: GatewayChatTask[] = []
    for (const state of leaseCandidates) {
      const attemptId = `attempt_${randomUUID()}`
      const leasedUntil = new Date(now + (state.task.lease?.lease_timeout_ms || leaseTimeoutMs)).toISOString()
      const leasedTask: GatewayChatTask = {
        ...clone(state.task),
        lease: {
          ...state.task.lease,
          attempt_id: attemptId,
          leased_until: leasedUntil,
        },
      }

      this.tasks.set(state.task.task_id, {
        ...state,
        task: leasedTask,
        status: 'leased',
        leasedBy: request.worker_id,
        attemptId,
        leasedUntil,
      })
      leasedTasks.push(clone(leasedTask))
    }

    return {
      tasks: leasedTasks,
      server_time: new Date(now).toISOString(),
    }
  }

  async submitResult(result: GatewayTaskResult): Promise<void> {
    const state = this.tasks.get(result.task_id)
    if (!state) {
      throw new Error(`Task not found: ${result.task_id}`)
    }
    this.tasks.set(result.task_id, {
      ...state,
      status: 'completed',
      result: clone(result),
    })
  }

  async submitFailure(failure: GatewayTaskFailure): Promise<void> {
    const state = this.tasks.get(failure.task_id)
    if (!state) {
      throw new Error(`Task not found: ${failure.task_id}`)
    }
    this.tasks.set(failure.task_id, {
      ...state,
      status: 'failed',
      failure: clone(failure),
    })
  }

  getRegistration(): WorkerRegistration | undefined {
    return this.registration ? clone(this.registration) : undefined
  }

  getHeartbeats(): GatewayHeartbeat[] {
    return clone(this.heartbeats)
  }

  getTaskStates(): MockTaskState[] {
    return clone([...this.tasks.values()])
  }

  getSubmittedResults(): GatewayTaskResult[] {
    return this.getTaskStates()
      .map(state => state.result)
      .filter((result): result is GatewayTaskResult => Boolean(result))
  }

  getSubmittedFailures(): GatewayTaskFailure[] {
    return this.getTaskStates()
      .map(state => state.failure)
      .filter((failure): failure is GatewayTaskFailure => Boolean(failure))
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
