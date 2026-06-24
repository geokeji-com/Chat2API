export const PROXY_ROUTE_HEADER_NAMES = [
  'X-Chat2API-Proxy-Mode',
  'X-Chat2API-Proxy-Id',
  'X-Chat2API-Proxy-Name',
  'X-Chat2API-Proxy-Host',
  'X-Chat2API-Proxy-Port',
  'X-Chat2API-Proxy-Address',
] as const

export const ACCOUNT_ROUTE_HEADER_NAMES = [
  'X-Chat2API-Account-Id',
  'X-Chat2API-Account-Name',
  'X-Chat2API-Provider-Id',
  'X-Chat2API-Provider-Name',
] as const

export const CHAT2API_ROUTE_HEADER_NAMES = [
  ...PROXY_ROUTE_HEADER_NAMES,
  ...ACCOUNT_ROUTE_HEADER_NAMES,
] as const

export interface ProxyRouteInfo {
  mode: 'proxy' | 'direct'
  id?: string
  name?: string
  host?: string
  port?: number
  address?: string
}

export interface AccountRouteInfo {
  id: string
  name: string
  providerId: string
  providerName: string
}

interface ProxyResultView {
  proxyId?: string
  proxyName?: string
  proxyHost?: string
  proxyPort?: number
}

interface AccountView {
  id: string
  name: string
}

interface ProviderView {
  id: string
  name: string
}

interface HeaderSetter {
  set(name: string, value: string): void
}

export function buildProxyRouteInfo(result: ProxyResultView): ProxyRouteInfo {
  if (!result.proxyHost || !result.proxyPort) {
    return { mode: 'direct' }
  }

  return {
    mode: 'proxy',
    id: result.proxyId,
    name: result.proxyName,
    host: result.proxyHost,
    port: result.proxyPort,
    address: `${result.proxyHost}:${result.proxyPort}`,
  }
}

export function buildAccountRouteInfo(account: AccountView, provider: ProviderView): AccountRouteInfo {
  return {
    id: account.id,
    name: account.name,
    providerId: provider.id,
    providerName: provider.name,
  }
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value)
}

export function setProxyRouteHeaders(ctx: HeaderSetter, proxy: ProxyRouteInfo): void {
  ctx.set('X-Chat2API-Proxy-Mode', proxy.mode)
  if (proxy.id) ctx.set('X-Chat2API-Proxy-Id', proxy.id)
  if (proxy.name) ctx.set('X-Chat2API-Proxy-Name', proxy.name)
  if (proxy.host) ctx.set('X-Chat2API-Proxy-Host', proxy.host)
  if (proxy.port !== undefined) ctx.set('X-Chat2API-Proxy-Port', String(proxy.port))
  if (proxy.address) ctx.set('X-Chat2API-Proxy-Address', proxy.address)
}

export function setAccountRouteHeaders(ctx: HeaderSetter, account: AccountRouteInfo): void {
  ctx.set('X-Chat2API-Account-Id', encodeHeaderValue(account.id))
  ctx.set('X-Chat2API-Account-Name', encodeHeaderValue(account.name))
  ctx.set('X-Chat2API-Provider-Id', encodeHeaderValue(account.providerId))
  ctx.set('X-Chat2API-Provider-Name', encodeHeaderValue(account.providerName))
}

export function attachProxyRouteInfo<T>(body: T, proxy: ProxyRouteInfo): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  const record = body as Record<string, any>
  return {
    ...record,
    chat2api: {
      ...(record.chat2api && typeof record.chat2api === 'object' ? record.chat2api : {}),
      proxy,
    },
  } as T
}

export function attachAccountRouteInfo<T>(body: T, account: AccountRouteInfo): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  const record = body as Record<string, any>
  return {
    ...record,
    chat2api: {
      ...(record.chat2api && typeof record.chat2api === 'object' ? record.chat2api : {}),
      account,
    },
  } as T
}
