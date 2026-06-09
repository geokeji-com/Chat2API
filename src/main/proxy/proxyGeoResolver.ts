import type { ProxyGeoInfo } from '../store/types'
import type { ProxyNode } from '../store/types'
import axios from 'axios'
import { SocksProxyAgent } from 'socks-proxy-agent'

const CZ88_ENDPOINT = 'https://cz88.net/api/cz88/ip/base'
const DEFAULT_TIMEOUT_MS = 15000

interface Cz88Response {
  code?: number
  success?: boolean
  message?: string
  data?: {
    province?: string
    city?: string
    provinceCode?: string
    cityCode?: string
    districtCode?: string
  }
}

function cleanText(value: unknown): string {
  const text = String(value || '').trim()
  return text && text !== '未知' ? text : ''
}

function formatRegionCode(value: unknown): string | undefined {
  const text = cleanText(value)
  if (!/^\d{6}$/.test(text)) return undefined
  return `ZH-${text}`
}

function buildSocksProxyUrl(node: ProxyNode): string {
  const auth = node.username
    ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password || '')}@`
    : ''
  return `socks5://${auth}${node.host}:${node.port}`
}

export function parseCz88GeoResponse(payload: unknown): ProxyGeoInfo | undefined {
  const response = payload as Cz88Response
  if (!response || response.success !== true || response.code !== 200 || !response.data) {
    return undefined
  }

  const province = cleanText(response.data.province)
  const city = cleanText(response.data.city)
  const regionCode = formatRegionCode(response.data.cityCode) ||
    formatRegionCode(response.data.districtCode) ||
    formatRegionCode(response.data.provinceCode)

  if (!province && !city && !regionCode) return undefined
  return {
    ...(province ? { province } : {}),
    ...(city ? { city } : {}),
    ...(regionCode ? { regionCode } : {}),
  }
}

export async function resolveProxyGeoByHost(
  host: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyGeoInfo> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const url = new URL(CZ88_ENDPOINT)
    url.searchParams.set('ip', host)
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`cz88 geo request failed with status ${response.status}`)
    }

    const payload = await response.json()
    const geo = parseCz88GeoResponse(payload)
    if (!geo) {
      const message = (payload as Cz88Response)?.message || 'cz88 geo response has no location'
      throw new Error(message)
    }
    return geo
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveProxyGeoViaNode(
  node: ProxyNode,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProxyGeoInfo> {
  const proxyUrl = buildSocksProxyUrl(node)
  const agent = new SocksProxyAgent(proxyUrl)
  const response = await axios.get(CZ88_ENDPOINT, {
    params: { ip: node.host },
    timeout: timeoutMs,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
    validateStatus: () => true,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`cz88 geo request failed with status ${response.status}`)
  }

  const geo = parseCz88GeoResponse(response.data)
  if (!geo) {
    const message = (response.data as Cz88Response | undefined)?.message || 'cz88 geo response has no location'
    throw new Error(message)
  }

  return geo
}
