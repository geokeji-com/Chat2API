import type { RpaCapturedRequest } from '../../shared/rpa'

const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-.*token|.*api.*key.*|.*session.*|.*csrf.*)$/i
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g
const TOKEN_PAIR_PATTERN =
  /("?[\w.-]*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|cookie|set-cookie|password|jwt|token)"?\s*[:=]\s*)"?[^",}\]\s;]+"?/gi

export const RPA_MAX_BODY_CHARS = 12000

export function sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedValue = normalizeHeaderValue(value)
    result[key] = SENSITIVE_HEADER_PATTERN.test(key)
      ? '[REDACTED]'
      : redactSensitiveText(normalizedValue)
  }

  return result
}

export function sanitizeBody(value: string | undefined): { body?: string; truncated?: boolean } {
  if (!value) {
    return {}
  }

  const redacted = redactSensitiveText(value)
  if (redacted.length <= RPA_MAX_BODY_CHARS) {
    return { body: redacted, truncated: false }
  }

  return {
    body: `${redacted.slice(0, RPA_MAX_BODY_CHARS)}...[truncated ${redacted.length - RPA_MAX_BODY_CHARS} chars]`,
    truncated: true,
  }
}

export function sanitizeCapturedRequest(request: RpaCapturedRequest): RpaCapturedRequest {
  const requestBody = sanitizeBody(request.requestBody)
  const responseBody = sanitizeBody(request.responseBody)

  return {
    ...request,
    requestHeaders: sanitizeHeaders(request.requestHeaders),
    responseHeaders: sanitizeHeaders(request.responseHeaders),
    requestBody: requestBody.body,
    responseBody: responseBody.body,
    bodyTruncated: Boolean(request.bodyTruncated || requestBody.truncated || responseBody.truncated),
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(TOKEN_PAIR_PATTERN, '$1"[REDACTED]"')
}

function normalizeHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ')
  }

  if (value === undefined || value === null) {
    return ''
  }

  return String(value)
}
