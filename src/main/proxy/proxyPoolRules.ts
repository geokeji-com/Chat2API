import type { Account, AccountProxyMode, ProxyNode } from '../store/types'

type ProxyAccountView = Pick<Account, 'id' | 'providerId' | 'status' | 'proxyMode' | 'proxyBinding'>

export function normalizeProxyMode(mode?: AccountProxyMode): AccountProxyMode {
  return mode === 'auto' ? 'auto' : 'none'
}

export function normalizeRegionCode(regionCode?: string | null): string | undefined {
  const text = String(regionCode || '').trim()
  if (!text) return undefined
  if (/^\d{6}$/.test(text)) return `ZH-${text}`
  const prefixed = text.toUpperCase()
  if (/^[A-Z]{2}-\d{6}$/.test(prefixed)) return prefixed
  return undefined
}

function isNodeCoolingDown(node: ProxyNode, now: number): boolean {
  return node.status === 'cooldown' && Boolean(node.cooldownUntil && node.cooldownUntil > now)
}

export function isProxyNodeAssignable(node: ProxyNode, now: number = Date.now()): boolean {
  if (!node.enabled) return false
  if (node.status === 'inactive') return false
  if (node.status === 'error') return false
  if (node.status === 'cooldown') {
    return !isNodeCoolingDown(node, now)
  }
  return node.status === 'active'
}

export function isProxyNodeUsedByProvider(
  accounts: ProxyAccountView[],
  proxyId: string,
  providerId: string,
  exceptAccountId?: string
): boolean {
  return accounts.some((account) =>
    account.id !== exceptAccountId &&
    account.providerId === providerId &&
    account.status === 'active' &&
    account.proxyMode === 'auto' &&
    account.proxyBinding?.proxyId === proxyId
  )
}

export function selectProxyNodeForAccount(
  nodes: ProxyNode[],
  accounts: ProxyAccountView[],
  providerId: string,
  accountId: string,
  excludedProxyId?: string,
  now: number = Date.now()
): ProxyNode | undefined {
  return nodes
    .filter(node => isProxyNodeAssignable(node, now))
    .filter(node => node.id !== excludedProxyId)
    .filter(node => !isProxyNodeUsedByProvider(accounts, node.id, providerId, accountId))
    .sort((a, b) => {
      const failureDiff = (a.failureCount || 0) - (b.failureCount || 0)
      if (failureDiff !== 0) return failureDiff
      return (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0)
    })[0]
}
