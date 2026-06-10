import tls from 'tls'
import type { AxiosRequestConfig } from 'axios'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { SocksClient } from 'socks'
import type { ProxyNode } from '../store/types.ts'

export interface OutboundProxyContext {
  node: ProxyNode
  url: string
}

export function createProxyContext(node?: ProxyNode): OutboundProxyContext | undefined {
  if (!node) return undefined
  return {
    node,
    url: buildSocksProxyUrl(node),
  }
}

export function buildSocksProxyUrl(node: ProxyNode): string {
  const auth = node.username
    ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password || '')}@`
    : ''
  return `socks5://${auth}${node.host}:${node.port}`
}

export function applyAxiosProxyConfig<T extends AxiosRequestConfig>(
  config: T,
  proxy?: OutboundProxyContext,
): T {
  if (!proxy) return config

  const agent = new SocksProxyAgent(proxy.url)
  return {
    ...config,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
  }
}

export async function createTlsSocketViaProxy(options: {
  proxy: OutboundProxyContext
  host: string
  port: number
  servername?: string
  timeout?: number
}): Promise<tls.TLSSocket> {
  const { proxy, host, port, servername, timeout } = options
  const result = await SocksClient.createConnection({
    proxy: {
      host: proxy.node.host,
      port: proxy.node.port,
      type: 5,
      userId: proxy.node.username,
      password: proxy.node.password,
    },
    command: 'connect',
    destination: { host, port },
    timeout,
  })

  return tls.connect({
    socket: result.socket,
    servername: servername || host,
    ALPNProtocols: ['h2'],
  })
}

export function isLikelyProxyTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true

  const anyError = error as {
    code?: string
    message?: string
    response?: unknown
  }

  if (anyError.response) return false

  const code = anyError.code || ''
  if ([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
  ].includes(code)) {
    return true
  }

  const message = (anyError.message || '').toLowerCase()
  return message.includes('socket') ||
    message.includes('socks') ||
    message.includes('proxy') ||
    message.includes('timeout') ||
    message.includes('tunneling') ||
    message.includes('network')
}
