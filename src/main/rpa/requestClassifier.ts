import type {
  RpaCapturedRequest,
  RpaCredentialReference,
  RpaEndpointFinding,
  RpaLearningResult,
  RpaTarget,
} from '../../shared/rpa'

export class RequestClassifier {
  classify(options: {
    sessionId: string
    target: RpaTarget
    requests: RpaCapturedRequest[]
    credentialsReference?: RpaCredentialReference
  }): RpaLearningResult {
    const findings = options.requests
      .map((request) => this.classifyRequest(request))
      .filter((finding) => finding.confidence >= 25)
      .sort((a, b) => b.confidence - a.confidence)

    const primaryChat = findings.find((finding) => finding.kind === 'chat')
    const warnings: string[] = []

    if (!primaryChat) {
      warnings.push('No high-confidence chat endpoint was detected. Run another learning pass while sending a normal text question.')
    } else if (primaryChat.confidence < 60) {
      warnings.push('The best chat endpoint has low confidence. Generate patch is disabled until another sample confirms the protocol.')
    }

    if (!findings.some((finding) => finding.kind === 'models')) {
      warnings.push('No model-list endpoint was detected. Generated provider config will use the learned request model or a placeholder.')
    }

    return {
      sessionId: options.sessionId,
      target: options.target,
      origin: getOrigin(options.target.url),
      capturedAt: Date.now(),
      requests: options.requests,
      findings,
      primaryChat,
      warnings,
      credentialsReference: options.credentialsReference,
    }
  }

  private classifyRequest(request: RpaCapturedRequest): RpaEndpointFinding {
    const url = new URL(request.url)
    const path = `${url.pathname}${url.search}`
    const haystack = [
      request.url,
      request.method,
      request.resourceType,
      request.mimeType,
      request.requestBody,
      request.responseBody,
    ].filter(Boolean).join('\n').toLowerCase()

    const requestJson = parseJson(request.requestBody)
    const responseJson = parseJson(stripSse(request.responseBody))
    const requestShape = extractShape(requestJson)
    const responseShape = extractShape(responseJson)
    const models = extractModels(responseJson)
    const reasons: string[] = []
    let chatScore = 0
    let modelScore = 0
    let sessionScore = 0

    if (request.method !== 'GET') {
      chatScore += 10
      sessionScore += 5
      reasons.push('non-GET request')
    }

    if (['Fetch', 'XHR', 'EventSource'].includes(request.resourceType)) {
      chatScore += 12
      modelScore += 8
      sessionScore += 8
      reasons.push(`${request.resourceType} request`)
    }

    if (request.isEventStream || /text\/event-stream|data:\s*\{/.test(haystack)) {
      chatScore += 22
      reasons.push('streaming response')
    }

    if (/(chat|completion|conversation|message|ask|stream|assistant)/i.test(path)) {
      chatScore += 24
      reasons.push('chat-like path')
    }

    if (/(model|models)/i.test(path)) {
      modelScore += 28
      reasons.push('model-like path')
    }

    if (/(session|conversation|thread|history)/i.test(path)) {
      sessionScore += 20
      reasons.push('session-like path')
    }

    if (/(messages|prompt|query|model|content|stream)/i.test(request.requestBody || '')) {
      chatScore += 26
      reasons.push('request body contains chat fields')
    }

    if (/(choices|delta|answer|message|content|reasoning|thinking|citations|conversation)/i.test(request.responseBody || '')) {
      chatScore += 24
      sessionScore += 8
      reasons.push('response body contains answer fields')
    }

    if (models.length > 0) {
      modelScore += 35
      reasons.push(`response contains ${models.length} model candidate(s)`)
    }

    const authHeaders = Object.keys(request.requestHeaders).filter((key) =>
      /authorization|cookie|token|session|csrf|api.*key/i.test(key),
    )

    const scores = [
      { kind: 'chat' as const, score: chatScore },
      { kind: 'models' as const, score: modelScore },
      { kind: 'session' as const, score: sessionScore },
    ].sort((a, b) => b.score - a.score)

    const best = scores[0]

    return {
      kind: best.score > 0 ? best.kind : 'unknown',
      method: request.method,
      url: request.url,
      path,
      status: request.status,
      confidence: Math.min(100, best.score),
      reasons: Array.from(new Set(reasons)).slice(0, 8),
      authHeaders,
      isStreaming: Boolean(request.isEventStream),
      requestShape,
      responseShape,
      models: models.slice(0, 50),
    }
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined

  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function stripSse(value: string | undefined): string | undefined {
  if (!value || !value.includes('data:')) {
    return value
  }

  const firstJsonLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: {'))

  return firstJsonLine?.replace(/^data:\s*/, '')
}

function extractShape(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? [`[${typeof value[0]}]`] : ['[]']
  }

  return Object.keys(value as Record<string, unknown>).slice(0, 30)
}

function extractModels(value: unknown): string[] {
  const models = new Set<string>()
  collectModels(value, models, 0)
  return Array.from(models)
}

function collectModels(value: unknown, models: Set<string>, depth: number): void {
  if (depth > 4 || !value) return

  if (typeof value === 'string') {
    if (looksLikeModelId(value)) {
      models.add(value)
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectModels(item, models, depth + 1)
    }
    return
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const candidate = object.id || object.model_id || object.model || object.name || object.display_name
    if (typeof candidate === 'string' && looksLikeModelId(candidate)) {
      models.add(candidate)
    }

    for (const nested of Object.values(object)) {
      collectModels(nested, models, depth + 1)
    }
  }
}

function looksLikeModelId(value: string): boolean {
  if (value.length < 2 || value.length > 80) return false
  return /[a-z0-9]/i.test(value) && /[-_.:/a-z0-9]/i.test(value)
}

function getOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}
