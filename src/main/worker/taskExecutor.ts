import type { Transform } from 'stream'
import type { Account, Provider } from '../store/types.ts'
import { requestForwarder, RequestForwarder } from '../proxy/forwarder.ts'
import { streamHandler } from '../proxy/stream.ts'
import { createFinalResponseTransform } from '../proxy/streamFinalResponse.ts'
import type { ChatCompletionRequest, ProxyContext } from '../proxy/types.ts'
import type { GatewayChatTask } from '../../shared/gatewayWorker.ts'
import type { WorkerAccountSelection } from './accountSelector.ts'
import { buildChatCompletionRequest } from './taskRequest.ts'
import { collectFinalResponseFromSse } from './streamCollector.ts'
import type { WorkerChatExecutionOutput } from './taskResult.ts'
import type { GatewayChatTaskExecutor } from './executorTypes.ts'

export class ForwarderTaskExecutor implements GatewayChatTaskExecutor {
  private readonly forwarder: RequestForwarder

  constructor(forwarder: RequestForwarder = requestForwarder) {
    this.forwarder = forwarder
  }

  async execute(task: GatewayChatTask, selection: WorkerAccountSelection): Promise<WorkerChatExecutionOutput> {
    const request = buildChatCompletionRequest(task)
    const context = createProxyContext(task, request, selection.account, selection.provider, selection.actualModel)
    const result = await this.forwarder.forwardChatCompletion(
      request,
      selection.account,
      selection.provider,
      selection.actualModel,
      context,
    )

    if (!result.success) {
      throw new Error(result.error || `Provider request failed with status ${result.status || 'unknown'}`)
    }

    if (request.stream) {
      if (!result.stream) {
        throw new Error('Provider returned no stream')
      }

      const normalizedStream = result.skipTransform
        ? result.stream
        : result.stream.pipe(streamHandler.createTransformStream(
          selection.actualModel,
          context.requestId,
        ))
      const finalResponseStream = normalizedStream.pipe(
        createFinalResponseTransform({
          model: selection.actualModel,
          responseId: context.requestId,
        }) as Transform,
      )

      return {
        response: await collectFinalResponseFromSse(finalResponseStream),
        providerMetadata: {
          provider_session_id: result.providerSessionId,
          parent_message_id: result.parentMessageId,
          proxy_id: result.proxyId,
          proxy_name: result.proxyName,
        },
      }
    }

    if (!result.body) {
      throw new Error('Provider returned empty response body')
    }

    return {
      response: result.body,
      providerMetadata: {
        provider_session_id: result.providerSessionId,
        parent_message_id: result.parentMessageId,
        proxy_id: result.proxyId,
        proxy_name: result.proxyName,
      },
    }
  }
}

function createProxyContext(
  task: GatewayChatTask,
  request: ChatCompletionRequest,
  account: Account,
  provider: Provider,
  actualModel: string,
): ProxyContext {
  return {
    requestId: `worker-${task.task_id}-${Date.now().toString(36)}`,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime: Date.now(),
    isStream: request.stream || false,
    clientIP: 'gateway-worker',
  }
}
