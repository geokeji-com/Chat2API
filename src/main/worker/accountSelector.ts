import type { Account, Provider, ProxyNode } from '../store/types.ts'
import type {
  GatewayChatTask,
  GatewayTaskAccountScope,
  WorkerAccountContext,
  WorkerGeoLocation,
} from '../../shared/gatewayWorker.ts'
import { normalizeRegionCode } from '../proxy/proxyPoolRules.ts'

export interface WorkerAccountSelection {
  account: Account
  provider: Provider
  actualModel: string
  accountContext: WorkerAccountContext
  score: number
  warnings: string[]
}

export interface SelectWorkerAccountInput {
  task: GatewayChatTask
  providers: Provider[]
  accounts: Account[]
  proxyNodes?: ProxyNode[]
}

type LocationSource = WorkerAccountContext['location_source']

interface ResolvedAccountLocation {
  location: WorkerGeoLocation
  source: LocationSource
  proxyNode?: ProxyNode
  tags: string[]
}

export function selectWorkerAccount(input: SelectWorkerAccountInput): WorkerAccountSelection | null {
  const provider = input.providers.find(candidate =>
    candidate.enabled &&
    candidate.id === input.task.platform.provider_id &&
    providerSupportsModel(candidate, input.task.platform.model)
  )

  if (!provider) {
    return null
  }

  const candidates = input.accounts
    .filter(account => account.providerId === provider.id)
    .filter(isAccountWorkerAvailable)
    .map(account => buildCandidate(account, provider, input.task, input.proxyNodes || []))
    .filter((candidate): candidate is WorkerAccountSelection => Boolean(candidate))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const usedDiff = (a.account.todayUsed || 0) - (b.account.todayUsed || 0)
      if (usedDiff !== 0) return usedDiff
      return (a.account.lastUsed || 0) - (b.account.lastUsed || 0)
    })

  return candidates[0] || null
}

export function resolveWorkerAccountContext(
  account: Account,
  provider: Provider,
  proxyNodes: ProxyNode[] = [],
): WorkerAccountContext {
  const resolved = resolveAccountLocation(account, proxyNodes)
  return {
    provider_id: provider.id,
    account_id: account.id,
    account_name: account.name,
    ...resolved.location,
    proxy_id: resolved.proxyNode?.id,
    proxy_name: resolved.proxyNode?.name,
    location_source: resolved.source,
  }
}

export function normalizeWorkerLocation(location?: WorkerGeoLocation | null): WorkerGeoLocation {
  return {
    ...(cleanText(location?.country) ? { country: cleanText(location?.country) } : {}),
    ...(cleanText(location?.province) ? { province: cleanText(location?.province) } : {}),
    ...(cleanText(location?.city) ? { city: cleanText(location?.city) } : {}),
    ...(normalizeRegionCode(location?.region_code) ? { region_code: normalizeRegionCode(location?.region_code) } : {}),
  }
}

function buildCandidate(
  account: Account,
  provider: Provider,
  task: GatewayChatTask,
  proxyNodes: ProxyNode[],
): WorkerAccountSelection | null {
  const scope = task.account_scope
  if (scope?.account_id && scope.account_id !== account.id) {
    return null
  }

  const resolved = resolveAccountLocation(account, proxyNodes)
  const policy = scope?.match_policy || (hasLocationConstraint(scope) ? 'required' : 'any')
  const locationMatch = scoreLocationMatch(scope, resolved.location)
  const tagMatch = scoreTagMatch(scope?.tags, resolved.tags)

  if (policy === 'required' && hasLocationConstraint(scope) && !locationMatch.matches) {
    return null
  }
  if (scope?.tags?.length && !tagMatch.matches) {
    return null
  }

  const context = resolveWorkerAccountContext(account, provider, proxyNodes)
  const score =
    (scope?.account_id ? 1000 : 0) +
    locationMatch.score +
    tagMatch.score +
    (account.featureConfig?.worker?.maxConcurrency ? 5 : 0)

  const warnings: string[] = []
  if (hasLocationConstraint(scope) && policy === 'preferred' && !locationMatch.matches) {
    warnings.push('preferred_account_location_not_matched')
  }
  if (context.location_source === 'unknown') {
    warnings.push('account_location_unknown')
  }

  return {
    account,
    provider,
    actualModel: mapActualModel(provider, task.platform.model),
    accountContext: context,
    score,
    warnings,
  }
}

function isAccountWorkerAvailable(account: Account): boolean {
  if (account.status !== 'active') {
    return false
  }
  if (account.dailyLimit && (account.todayUsed || 0) >= account.dailyLimit) {
    return false
  }
  return account.featureConfig?.worker?.enabled !== false
}

function providerSupportsModel(provider: Provider, model: string): boolean {
  if (provider.modelMappings?.[model]) {
    return true
  }
  if (!provider.supportedModels || provider.supportedModels.length === 0) {
    return true
  }

  const normalizedModel = model.toLowerCase()
  return provider.supportedModels.some(supported => {
    const normalizedSupported = supported.toLowerCase()
    if (normalizedSupported.endsWith('*')) {
      return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
    }
    return normalizedSupported === normalizedModel
  })
}

function mapActualModel(provider: Provider, model: string): string {
  return provider.modelMappings?.[model] || model
}

function resolveAccountLocation(account: Account, proxyNodes: ProxyNode[]): ResolvedAccountLocation {
  const workerConfig = account.featureConfig?.worker
  const explicit = workerConfig?.location
  const explicitLocation = normalizeWorkerLocation({
    country: explicit?.country,
    province: explicit?.province,
    city: explicit?.city,
    region_code: explicit?.regionCode,
  })
  const explicitTags = [...(workerConfig?.tags || []), ...(explicit?.tags || [])]
    .map(tag => tag.trim())
    .filter(Boolean)

  if (Object.keys(explicitLocation).length > 0 || explicitTags.length > 0) {
    return {
      location: explicitLocation,
      source: 'account_feature',
      proxyNode: getBoundProxyNode(account, proxyNodes),
      tags: explicitTags,
    }
  }

  const proxyNode = getBoundProxyNode(account, proxyNodes)
  if (proxyNode) {
    return {
      location: normalizeWorkerLocation({
        province: proxyNode.province,
        city: proxyNode.city,
        region_code: proxyNode.regionCode,
      }),
      source: 'proxy_binding',
      proxyNode,
      tags: [],
    }
  }

  return {
    location: {},
    source: 'unknown',
    tags: [],
  }
}

function getBoundProxyNode(account: Account, proxyNodes: ProxyNode[]): ProxyNode | undefined {
  const proxyId = account.proxyBinding?.proxyId
  if (!proxyId) {
    return undefined
  }
  return proxyNodes.find(node => node.id === proxyId)
}

function scoreLocationMatch(
  scope: GatewayTaskAccountScope | undefined,
  location: WorkerGeoLocation,
): { matches: boolean; score: number } {
  if (!hasLocationConstraint(scope)) {
    return { matches: true, score: 0 }
  }

  const requested = normalizeWorkerLocation(scope)
  let matches = true
  let score = 0

  if (requested.region_code) {
    const sameRegion = normalizeRegionCode(location.region_code) === requested.region_code
    matches = matches && sameRegion
    if (sameRegion) score += 300
  }

  if (requested.city) {
    const sameCity = normalizeCityName(location.city) === normalizeCityName(requested.city)
    matches = matches && sameCity
    if (sameCity) score += 120
  }

  if (requested.province) {
    const sameProvince = normalizeCityName(location.province) === normalizeCityName(requested.province)
    matches = matches && sameProvince
    if (sameProvince) score += 60
  }

  if (requested.country) {
    const sameCountry = normalizeCityName(location.country) === normalizeCityName(requested.country)
    matches = matches && sameCountry
    if (sameCountry) score += 20
  }

  return { matches, score }
}

function scoreTagMatch(
  requestedTags: string[] | undefined,
  accountTags: string[],
): { matches: boolean; score: number } {
  const normalizedRequested = normalizeTags(requestedTags || [])
  if (normalizedRequested.length === 0) {
    return { matches: true, score: 0 }
  }

  const normalizedAccountTags = new Set(normalizeTags(accountTags))
  const matched = normalizedRequested.filter(tag => normalizedAccountTags.has(tag))
  return {
    matches: matched.length === normalizedRequested.length,
    score: matched.length * 20,
  }
}

function hasLocationConstraint(scope?: GatewayTaskAccountScope): boolean {
  return Boolean(scope?.country || scope?.province || scope?.city || scope?.region_code)
}

function normalizeTags(tags: string[]): string[] {
  return tags
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean)
}

function normalizeCityName(value?: string): string {
  return (cleanText(value) || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[市省区县]$/u, '')
}

function cleanText(value?: string | null): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}
