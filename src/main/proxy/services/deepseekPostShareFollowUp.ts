import type { DeepSeekMessageId, DeepSeekShareInfo } from '../adapters/deepseek.ts'
import type { Account, DeepSeekPostShareFollowUpConfig } from '../../store/types.ts'
import { resolveDeepSeekFollowUpConfig } from '../../../shared/deepseekFollowUp.ts'

export interface DeepSeekPostShareFollowUpPlan {
  initialParentMessageId: DeepSeekMessageId
  prompts: string[]
  delayMs: number
}

export interface ExecuteDeepSeekPostShareFollowUpsOptions extends DeepSeekPostShareFollowUpPlan {
  sessionId: string
  model: string
  wait?: (delayMs: number) => Promise<void>
  sendFollowUp: (
    sessionId: string,
    parentMessageId: DeepSeekMessageId,
    prompt: string,
    model: string
  ) => Promise<DeepSeekMessageId | undefined>
}

export function resolveDeepSeekPostShareFollowUpConfig(options: {
  defaultConfig: DeepSeekPostShareFollowUpConfig
  account?: Pick<Account, 'featureConfig'>
}): DeepSeekPostShareFollowUpConfig {
  return resolveDeepSeekFollowUpConfig(options.defaultConfig, options.account)
}

function hasMessageId(messageId: DeepSeekMessageId | undefined): messageId is DeepSeekMessageId {
  return (typeof messageId === 'string' && messageId.length > 0)
    || (typeof messageId === 'number' && Number.isFinite(messageId))
}

export function createDeepSeekPostShareFollowUpPlan(options: {
  config: DeepSeekPostShareFollowUpConfig
  shareInfo: DeepSeekShareInfo | undefined
  finishReason: string | undefined
}): DeepSeekPostShareFollowUpPlan | undefined {
  const { config, shareInfo, finishReason } = options
  if (!config.enabled || finishReason !== 'stop') {
    return undefined
  }

  if (!shareInfo?.share_url || !hasMessageId(shareInfo.message_id)) {
    return undefined
  }

  const prompts = (Array.isArray(config.prompts) ? config.prompts : [])
    .filter((prompt): prompt is string => typeof prompt === 'string' && prompt.trim().length > 0)

  if (prompts.length !== 2) {
    return undefined
  }

  return {
    initialParentMessageId: shareInfo.message_id,
    prompts,
    delayMs: Number.isFinite(config.delayMs) && config.delayMs >= 0 ? config.delayMs : 0,
  }
}

export async function executeDeepSeekPostShareFollowUps(
  options: ExecuteDeepSeekPostShareFollowUpsOptions
): Promise<DeepSeekMessageId[]> {
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)))
  if (options.delayMs > 0) {
    await wait(options.delayMs)
  }

  const responseMessageIds: DeepSeekMessageId[] = []
  let parentMessageId = options.initialParentMessageId

  for (const prompt of options.prompts) {
    const responseMessageId = await options.sendFollowUp(
      options.sessionId,
      parentMessageId,
      prompt,
      options.model,
    )

    if (!hasMessageId(responseMessageId)) {
      throw new Error('DeepSeek follow-up response message ID was not found')
    }

    responseMessageIds.push(responseMessageId)
    parentMessageId = responseMessageId
  }

  return responseMessageIds
}
