export const PROXY_ROUTE_HEADER_NAMES = [
  'X-Chat2API-Proxy-Mode',
  'X-Chat2API-Proxy-Id',
  'X-Chat2API-Proxy-Name',
  'X-Chat2API-Proxy-Host',
  'X-Chat2API-Proxy-Port',
  'X-Chat2API-Proxy-Address',
] as const

export interface ProxyRouteInfo {
  mode: 'proxy' | 'direct'
  id?: string
  name?: string
  host?: string
  port?: number
  address?: string
}

interface ProxyResultView {
  proxyId?: string
  proxyName?: string
  proxyHost?: string
  proxyPort?: number
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

export function setProxyRouteHeaders(ctx: HeaderSetter, proxy: ProxyRouteInfo): void {
  ctx.set('X-Chat2API-Proxy-Mode', proxy.mode)
  if (proxy.id) ctx.set('X-Chat2API-Proxy-Id', proxy.id)
  if (proxy.name) ctx.set('X-Chat2API-Proxy-Name', proxy.name)
  if (proxy.host) ctx.set('X-Chat2API-Proxy-Host', proxy.host)
  if (proxy.port !== undefined) ctx.set('X-Chat2API-Proxy-Port', String(proxy.port))
  if (proxy.address) ctx.set('X-Chat2API-Proxy-Address', proxy.address)
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
