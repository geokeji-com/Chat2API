import type { Account, Provider, ProxyNode } from '../store/types.ts'
import type { WorkerCapability, WorkerGeoLocation, WorkerRegistration } from '../../shared/gatewayWorker.ts'
import { resolveWorkerAccountContext } from './accountSelector.ts'

export interface CreateWorkerRegistrationInput {
  workerId: string
  name: string
  version: string
  providers: Provider[]
  accounts: Account[]
  proxyNodes?: ProxyNode[]
  maxCachedTasks: number
  maxTaskTimeoutMs: number
  defaultMaxConcurrency?: number
  metadata?: Record<string, unknown>
}

export function createWorkerRegistration(input: CreateWorkerRegistrationInput): WorkerRegistration {
  return {
    worker_id: input.workerId,
    name: input.name,
    version: input.version,
    capabilities: createWorkerCapabilities(input),
    limits: {
      max_cached_tasks: input.maxCachedTasks,
      max_task_timeout_ms: input.maxTaskTimeoutMs,
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export function createWorkerCapabilities(input: CreateWorkerRegistrationInput): WorkerCapability[] {
  return input.providers
    .filter(provider => provider.enabled)
    .map(provider => {
      const providerAccounts = input.accounts
        .filter(account => account.providerId === provider.id)
        .filter(account => account.status === 'active')
        .filter(account => account.featureConfig?.worker?.enabled !== false)

      if (providerAccounts.length === 0) {
        return undefined
      }

      const accountLocations = dedupeLocations(
        providerAccounts.map(account =>
          resolveWorkerAccountContext(account, provider, input.proxyNodes || [])
        )
      )

      return {
        provider_id: provider.id,
        models: listProviderModels(provider),
        account_locations: accountLocations,
        features: inferProviderFeatures(provider),
        max_concurrency: providerAccounts.reduce((total, account) =>
          total + (account.featureConfig?.worker?.maxConcurrency || input.defaultMaxConcurrency || 1),
        0),
      }
    })
    .filter((capability): capability is WorkerCapability => Boolean(capability))
}

function listProviderModels(provider: Provider): string[] {
  const models = new Set<string>()
  for (const model of provider.supportedModels || []) {
    models.add(model)
  }
  for (const model of Object.keys(provider.modelMappings || {})) {
    models.add(model)
  }
  return [...models].sort()
}

function inferProviderFeatures(provider: Provider): WorkerCapability['features'] {
  const providerId = provider.id.toLowerCase()
  const isDeepSeek = providerId.includes('deepseek')
  const isPerplexity = providerId.includes('perplexity')

  return {
    stream: true,
    web_search: isDeepSeek || isPerplexity,
    thinking: isDeepSeek || providerId.includes('glm') || providerId.includes('qwen'),
    share_url: isDeepSeek,
    citations: isDeepSeek || isPerplexity,
  }
}

function dedupeLocations(locations: WorkerGeoLocation[]): WorkerGeoLocation[] {
  const unique = new Map<string, WorkerGeoLocation>()
  for (const location of locations) {
    const normalized = {
      ...(location.country ? { country: location.country } : {}),
      ...(location.province ? { province: location.province } : {}),
      ...(location.city ? { city: location.city } : {}),
      ...(location.region_code ? { region_code: location.region_code } : {}),
    }
    const key = [
      normalized.country || '',
      normalized.province || '',
      normalized.city || '',
      normalized.region_code || '',
    ].join('|')
    unique.set(key, normalized)
  }
  return [...unique.values()]
}
