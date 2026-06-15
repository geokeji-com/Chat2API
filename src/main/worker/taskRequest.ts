import type { ChatCompletionRequest } from '../proxy/types.ts'
import type { GatewayChatTask } from '../../shared/gatewayWorker.ts'

export function buildChatCompletionRequest(task: GatewayChatTask): ChatCompletionRequest {
  const stream = task.mode?.stream ?? true
  const includeFinalResponse = task.mode?.include_final_response ?? stream
  const webSearch = task.mode?.web_search ?? task.platform.model.toLowerCase().includes('search')
  const reasoningEffort = task.mode?.reasoning_effort || (task.mode?.thinking ? 'medium' : undefined)

  return {
    model: task.platform.model,
    stream,
    ...(stream ? {
      stream_options: {
        include_final_response: includeFinalResponse,
      },
    } : {}),
    messages: task.input.messages.map(message => ({
      role: message.role,
      content: message.content as ChatCompletionRequest['messages'][number]['content'],
    })),
    ...(webSearch ? {
      web_search: true,
      web_search_options: {
        user_location: {
          type: 'approximate',
          approximate: {
            ...(task.target?.country ? { country: task.target.country } : {}),
            ...(task.target?.province ? { region: task.target.province } : {}),
            ...(task.target?.city ? { city: task.target.city } : {}),
          },
        },
      },
    } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }
}
