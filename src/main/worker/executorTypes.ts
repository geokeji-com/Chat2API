import type { GatewayChatTask } from '../../shared/gatewayWorker.ts'
import type { WorkerAccountSelection } from './accountSelector.ts'
import type { WorkerChatExecutionOutput } from './taskResult.ts'

export interface GatewayChatTaskExecutor {
  execute(task: GatewayChatTask, selection: WorkerAccountSelection): Promise<WorkerChatExecutionOutput>
}
