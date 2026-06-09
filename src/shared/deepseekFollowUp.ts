import type {
  Account,
  AccountFeatureConfig,
  DeepSeekPostShareFollowUpConfig,
} from './types'

export interface DeepSeekFollowUpValidation {
  promptErrors: [string | undefined, string | undefined]
  delayMsError?: string
  isValid: boolean
}

export const DEEPSEEK_FOLLOW_UP_PROMPT_COUNT = 2

export function normalizeDeepSeekFollowUpConfig(
  config: DeepSeekPostShareFollowUpConfig
): DeepSeekPostShareFollowUpConfig {
  const prompts = Array.isArray(config.prompts)
    ? config.prompts.slice(0, DEEPSEEK_FOLLOW_UP_PROMPT_COUNT)
    : []

  return {
    enabled: Boolean(config.enabled),
    prompts: [
      typeof prompts[0] === 'string' ? prompts[0] : '',
      typeof prompts[1] === 'string' ? prompts[1] : '',
    ],
    delayMs: Number.isFinite(Number(config.delayMs)) && Number(config.delayMs) >= 0
      ? Number(config.delayMs)
      : 0,
  }
}

export function getDeepSeekFollowUpOverride(
  account: Pick<Account, 'featureConfig'> | undefined
): DeepSeekPostShareFollowUpConfig | undefined {
  return account?.featureConfig?.deepSeekPostShareFollowUp
}

export function resolveDeepSeekFollowUpConfig(
  defaultConfig: DeepSeekPostShareFollowUpConfig,
  account?: Pick<Account, 'featureConfig'>
): DeepSeekPostShareFollowUpConfig {
  const overrideConfig = getDeepSeekFollowUpOverride(account)
  return normalizeDeepSeekFollowUpConfig(overrideConfig ?? defaultConfig)
}

export function getDeepSeekFollowUpStatus(
  account: Pick<Account, 'featureConfig'>
): 'inherit' | 'enabled' | 'disabled' {
  const overrideConfig = getDeepSeekFollowUpOverride(account)
  if (!overrideConfig) {
    return 'inherit'
  }
  return overrideConfig.enabled ? 'enabled' : 'disabled'
}

export function validateDeepSeekFollowUpConfig(
  config: DeepSeekPostShareFollowUpConfig,
  messages: {
    promptRequired: string
    delayNonNegative: string
  }
): DeepSeekFollowUpValidation {
  const promptErrors = config.prompts.map((prompt) =>
    typeof prompt === 'string' && prompt.trim().length > 0
      ? undefined
      : messages.promptRequired
  ) as [string | undefined, string | undefined]

  const delayMs = Number(config.delayMs)
  const delayMsError = Number.isFinite(delayMs) && delayMs >= 0
    ? undefined
    : messages.delayNonNegative

  return {
    promptErrors,
    delayMsError,
    isValid: promptErrors.every(error => !error) && !delayMsError,
  }
}

export function buildDeepSeekFollowUpFeatureConfig(
  existingFeatureConfig: AccountFeatureConfig | undefined,
  config: DeepSeekPostShareFollowUpConfig
): AccountFeatureConfig {
  return {
    ...existingFeatureConfig,
    deepSeekPostShareFollowUp: normalizeDeepSeekFollowUpConfig(config),
  }
}

export function removeDeepSeekFollowUpFeatureConfig(
  existingFeatureConfig: AccountFeatureConfig | undefined
): AccountFeatureConfig | undefined {
  if (!existingFeatureConfig?.deepSeekPostShareFollowUp) {
    return existingFeatureConfig
  }

  const { deepSeekPostShareFollowUp: _removed, ...remainingConfig } = existingFeatureConfig
  return Object.keys(remainingConfig).length > 0 ? remainingConfig : undefined
}
