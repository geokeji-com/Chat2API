import fs from 'fs'
import path from 'path'

const SENSITIVE_KEY_PATTERN = /authorization|cookie|token|secret|password|credential|x-ds-pow-response|set-cookie/i
const MAX_STRING_LENGTH = 2_000_000

function projectLogRoot(): string {
  return path.resolve(process.cwd(), 'logs', 'platform-calls')
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function resolveDebugTraceLogFile(logFile?: string): string | undefined {
  if (!logFile || typeof logFile !== 'string') {
    return undefined
  }

  const root = projectLogRoot()
  const requested = path.resolve(logFile)
  if (isInside(root, requested)) {
    return requested
  }

  return path.join(root, path.basename(requested))
}

function looksLikeStream(value: any): boolean {
  return value
    && typeof value === 'object'
    && typeof value.on === 'function'
    && typeof value.pipe === 'function'
}

export function sanitizeDebugTraceValue(value: any, keyHint = '', depth = 0): any {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return '[redacted]'
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`
      : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (looksLikeStream(value)) {
    return '[stream]'
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }

  if (depth >= 8) {
    return '[max-depth]'
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeDebugTraceValue(item, keyHint, depth + 1))
  }

  if (typeof value === 'object') {
    const result: Record<string, any> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = sanitizeDebugTraceValue(nested, key, depth + 1)
    }
    return result
  }

  return String(value)
}

export function appendDebugTraceEvent(
  logFile: string | undefined,
  event: string,
  data: Record<string, any>
): void {
  const resolved = resolveDebugTraceLogFile(logFile)
  if (!resolved) {
    return
  }

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    const entry = sanitizeDebugTraceValue({
      timestamp: new Date().toISOString(),
      event,
      ...data,
    })
    fs.appendFileSync(resolved, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    console.warn('[DebugTrace] Failed to append debug trace event:', error)
  }
}
