import { EventEmitter } from 'node:events'
import type { RpaCapturedRequest, RpaTarget } from '../../shared/rpa'
import { ChromeCdpClient } from './cdpClient.ts'
import { sanitizeBody, sanitizeCapturedRequest, sanitizeHeaders } from './sanitizer.ts'

interface PartialRequest {
  id: string
  url: string
  method: string
  resourceType: string
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  requestBody?: string
  responseBody?: string
  status?: number
  mimeType?: string
  startedAt: number
  endedAt?: number
  isEventStream?: boolean
  bodyTruncated?: boolean
  error?: string
}

interface NetworkCaptureOptions {
  captureDomains?: string[]
}

export class NetworkCaptureService extends EventEmitter {
  private cdp: ChromeCdpClient | null = null
  private readonly requests = new Map<string, PartialRequest>()
  private readonly captured: RpaCapturedRequest[] = []
  private readonly allowedDomains: string[]
  private readonly target: RpaTarget

  constructor(target: RpaTarget, options: NetworkCaptureOptions = {}) {
    super()
    this.target = target
    const captureDomains = Array.isArray(options.captureDomains) ? options.captureDomains : []
    this.allowedDomains = Array.from(new Set([
      getRegistrableRoot(target.url),
      ...captureDomains,
    ].map(normalizeDomain).filter(Boolean)))
  }

  async start(): Promise<void> {
    if (!this.target.webSocketDebuggerUrl) {
      throw new Error('Selected browser tab does not expose a DevTools WebSocket URL')
    }

    this.cdp = await ChromeCdpClient.connect(this.target.webSocketDebuggerUrl)
    this.bindEvents(this.cdp)

    await this.cdp.send('Network.enable', {
      maxTotalBufferSize: 20_000_000,
      maxResourceBufferSize: 10_000_000,
      maxPostDataSize: 1_000_000,
    })
    await this.cdp.send('Page.enable').catch(() => undefined)
  }

  async stop(): Promise<RpaCapturedRequest[]> {
    if (this.cdp) {
      await this.cdp.send('Network.disable').catch(() => undefined)
      this.cdp.close()
      this.cdp = null
    }

    return [...this.captured]
  }

  getCaptured(): RpaCapturedRequest[] {
    return [...this.captured]
  }

  private bindEvents(cdp: ChromeCdpClient): void {
    cdp.on('Network.requestWillBeSent', (params) => this.handleRequestWillBeSent(params))
    cdp.on('Network.requestWillBeSentExtraInfo', (params) => this.handleRequestExtraInfo(params))
    cdp.on('Network.responseReceived', (params) => this.handleResponseReceived(params))
    cdp.on('Network.loadingFinished', (params) => void this.handleLoadingFinished(params))
    cdp.on('Network.loadingFailed', (params) => this.handleLoadingFailed(params))
  }

  private handleRequestWillBeSent(params: any): void {
    const request = params.request
    if (!request?.url || !this.shouldCaptureUrl(request.url, params.type)) {
      return
    }

    this.requests.set(params.requestId, {
      id: params.requestId,
      url: request.url,
      method: request.method || 'GET',
      resourceType: params.type || 'Other',
      requestHeaders: sanitizeHeaders(request.headers),
      responseHeaders: {},
      requestBody: sanitizeBody(request.postData).body,
      startedAt: Date.now(),
    })

    this.emitRequestSnapshot(params.requestId, 'started')
  }

  private handleRequestExtraInfo(params: any): void {
    const request = this.requests.get(params.requestId)
    if (!request) return

    request.requestHeaders = {
      ...request.requestHeaders,
      ...sanitizeHeaders(params.headers),
    }
  }

  private handleResponseReceived(params: any): void {
    const request = this.requests.get(params.requestId)
    if (!request) return

    const response = params.response || {}
    request.status = response.status
    request.mimeType = response.mimeType
    request.responseHeaders = sanitizeHeaders(response.headers)
    request.isEventStream = String(response.mimeType || '').includes('event-stream') ||
      String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || '').includes('event-stream')

    this.emitRequestSnapshot(params.requestId, 'response')
  }

  private async handleLoadingFinished(params: any): Promise<void> {
    const request = this.requests.get(params.requestId)
    if (!request || !this.cdp) return

    request.endedAt = Date.now()

    try {
      if (!request.requestBody && request.method !== 'GET') {
        const postData = await this.cdp.send<{ postData?: string }>('Network.getRequestPostData', {
          requestId: params.requestId,
        }).catch(() => undefined)
        if (postData?.postData) {
          request.requestBody = sanitizeBody(postData.postData).body
        }
      }

      const responseBody = await this.cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
        requestId: params.requestId,
      }).catch(() => undefined)

      if (responseBody?.body) {
        const decoded = responseBody.base64Encoded
          ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
          : responseBody.body
        const sanitized = sanitizeBody(decoded)
        request.responseBody = sanitized.body
        request.bodyTruncated = sanitized.truncated
      }
    } finally {
      this.captureCompletedRequest(request, 'completed')
      this.requests.delete(params.requestId)
    }
  }

  private handleLoadingFailed(params: any): void {
    const request = this.requests.get(params.requestId)
    if (!request) return

    request.endedAt = Date.now()
    request.error = params.errorText || 'Request failed'
    this.captureCompletedRequest(request, 'failed')
    this.requests.delete(params.requestId)
  }

  private emitRequestSnapshot(requestId: string, lifecycle: RpaCapturedRequest['lifecycle']): void {
    const request = this.requests.get(requestId)
    if (!request) return

    const captured = this.toCapturedRequest(request, lifecycle)
    this.captured.push(captured)
    this.emit('captured', captured)
  }

  private captureCompletedRequest(
    partial: PartialRequest,
    lifecycle: RpaCapturedRequest['lifecycle'],
  ): void {
    const captured = this.toCapturedRequest(partial, lifecycle)
    this.captured.push(captured)
    this.emit('captured', captured)
  }

  private toCapturedRequest(
    partial: PartialRequest,
    lifecycle: RpaCapturedRequest['lifecycle'],
  ): RpaCapturedRequest {
    const captured = sanitizeCapturedRequest({
      ...partial,
      id: `${partial.id}:${lifecycle}`,
      lifecycle,
      requestHeaders: partial.requestHeaders,
      responseHeaders: partial.responseHeaders,
    })

    return captured
  }

  private shouldCaptureUrl(url: string, resourceType: string | undefined): boolean {
    if (isStaticResourceType(resourceType)) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false
    }

    if (this.allowedDomains.length > 0 && !this.allowedDomains.some((domain) => hostMatchesDomain(parsed.hostname, domain))) {
      return false
    }

    if (isLikelyNoise(parsed)) {
      return false
    }

    return true
  }
}

function isStaticResourceType(resourceType: string | undefined): boolean {
  return ['Image', 'Stylesheet', 'Font', 'Media', 'Script'].includes(resourceType || '')
}

function isLikelyNoise(url: URL): boolean {
  const text = `${url.hostname}${url.pathname}`.toLowerCase()
  return [
    'google-analytics',
    'googletagmanager',
    'doubleclick',
    'sentry',
    'segment',
    'amplitude',
    'mixpanel',
    'hotjar',
    '/analytics',
    '/telemetry',
    '/metrics',
    '/log',
    '/logs',
  ].some((pattern) => text.includes(pattern))
}

function getRegistrableRoot(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname
    const parts = hostname.split('.').filter(Boolean)
    if (parts.length <= 2) {
      return hostname
    }

    return parts.slice(-2).join('.')
  } catch {
    return undefined
  }
}

function normalizeDomain(value: string | undefined | null): string | undefined {
  if (!value) return undefined

  try {
    return new URL(value).hostname.toLowerCase().replace(/^\*\./, '').replace(/^\./, '')
  } catch {
    return value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '') || undefined
  }
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}
