import type { Account, ProxyNode } from '../../../shared/types'

interface ProxyBindingLabels {
  direct: string
  pending: string
}

export function formatProxyNodeLabel(node: ProxyNode, proxyId: string = node.id): string {
  const shortId = proxyId.slice(0, 8)
  return `${node.name} (${node.host}:${node.port}, ${shortId})`
}

export function formatAccountProxyBinding(
  account: Pick<Account, 'proxyMode' | 'proxyBinding'>,
  proxyNodes: ProxyNode[],
  labels: ProxyBindingLabels,
): string {
  if (account.proxyMode !== 'auto') return labels.direct

  const proxyId = account.proxyBinding?.proxyId
  if (!proxyId) return labels.pending

  const node = proxyNodes.find((item) => item.id === proxyId)
  return node ? formatProxyNodeLabel(node, proxyId) : proxyId
}
