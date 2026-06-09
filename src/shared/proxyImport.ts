export interface ParsedProxyImportNode {
  name: string
  host: string
  port: number
  username?: string
  password?: string
  province?: string
  city?: string
  regionCode?: string
  enabled: boolean
  sourceLine: number
}

export interface ProxyImportIssue {
  line: number
  input: string
  code: 'empty' | 'invalid' | 'duplicate'
  message: string
}

export interface ProxyImportResult {
  nodes: ParsedProxyImportNode[]
  issues: ProxyImportIssue[]
  totalLines: number
}

const HOST_KEYS = new Set(['host', 'hostname', 'ip', 'server', 'address', 'addr'])
const PORT_KEYS = new Set(['port', 'socks_port', 'proxy_port'])
const USER_KEYS = new Set(['user', 'username', 'login', 'account'])
const PASSWORD_KEYS = new Set(['pass', 'password', 'pwd'])
const NAME_KEYS = new Set(['name', 'label', 'remark', 'remarks', 'tag', 'title'])
const PROVINCE_KEYS = new Set(['province', 'province_name', 'prov', 'state', '省', '省份'])
const CITY_KEYS = new Set(['city', 'city_name', 'municipality', '城市', '市'])
const REGION_CODE_KEYS = new Set([
  'region_code',
  'city_code',
  'area_code',
  'admin_code',
  'administrative_code',
  'division_code',
  'adcode',
  'code',
  'postal_code',
  'postcode',
  'zip',
  'zip_code',
  '地区代码',
  '城市代码',
  '行政区划代码',
  '区划代码',
  '邮编',
])

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function cleanValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  return text.replace(/^['"]|['"]$/g, '').trim()
}

function isValidPort(value: unknown): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function isLikelyRegionCode(value: unknown): boolean {
  return /^(?:[A-Z]{2}-)?\d{6}$/i.test(cleanValue(value))
}

function normalizeRegionCode(value: unknown): string {
  const text = cleanValue(value)
  if (!text) return ''
  if (/^\d{6}$/.test(text)) return `ZH-${text}`
  return text.toUpperCase()
}

function looksLikeHost(value: string): boolean {
  if (!value || value.length > 253) return false
  if (value.includes('://')) return false
  if (/^\[[^\]]+\]$/.test(value)) return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return true
  if (value === 'localhost') return true
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/.test(value)) return true
  return value.includes(':')
}

function createDefaultName(host: string, port: number): string {
  return `${host}:${port}`
}

function stripLineNoise(line: string): string {
  return line
    .trim()
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
    .trim()
}

function splitRecords(text: string): Array<{ line: number; text: string }> {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: stripLineNoise(line) }))
    .filter(record => record.text && !record.text.startsWith('#') && !record.text.startsWith('//'))
}

function splitColumns(line: string): string[] {
  const delimiter = ['\t', '|', ',', ';'].find(item => line.includes(item))
  if (delimiter) {
    return line.split(delimiter).map(part => cleanValue(part))
  }
  return line.split(/\s+/).map(part => cleanValue(part)).filter(Boolean)
}

function hasHeader(columns: string[]): boolean {
  const keys = columns.map(normalizeKey)
  return keys.some(key => HOST_KEYS.has(key)) && keys.some(key => PORT_KEYS.has(key))
}

function parseFromMappedObject(data: Record<string, unknown>, line: number): ParsedProxyImportNode | undefined {
  let host = ''
  let port = ''
  let username = ''
  let password = ''
  let name = ''
  let province = ''
  let city = ''
  let regionCode = ''

  for (const [rawKey, value] of Object.entries(data)) {
    const key = normalizeKey(rawKey)
    if (HOST_KEYS.has(key)) host = cleanValue(value)
    else if (PORT_KEYS.has(key)) port = cleanValue(value)
    else if (USER_KEYS.has(key)) username = cleanValue(value)
    else if (PASSWORD_KEYS.has(key)) password = cleanValue(value)
    else if (NAME_KEYS.has(key)) name = cleanValue(value)
    else if (PROVINCE_KEYS.has(key)) province = cleanValue(value)
    else if (CITY_KEYS.has(key)) city = cleanValue(value)
    else if (REGION_CODE_KEYS.has(key)) regionCode = normalizeRegionCode(value)
  }

  if (!host || !isValidPort(port)) return undefined
  const parsedPort = Number(port)
  return {
    name: name || createDefaultName(host, parsedPort),
    host,
    port: parsedPort,
    username: username || undefined,
    password: password || undefined,
    ...(province ? { province } : {}),
    ...(city ? { city } : {}),
    ...(regionCode ? { regionCode } : {}),
    enabled: true,
    sourceLine: line,
  }
}

function parseJson(text: string): ParsedProxyImportNode[] | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined

  try {
    const parsed = JSON.parse(trimmed)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    const nodes = items
      .map((item, index) =>
        item && typeof item === 'object'
          ? parseFromMappedObject(item as Record<string, unknown>, index + 1)
          : undefined
      )
      .filter((item): item is ParsedProxyImportNode => Boolean(item))
    return nodes.length > 0 ? nodes : undefined
  } catch {
    return undefined
  }
}

function parseUrlRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  if (!/^(?:socks5h?|socks):\/\//i.test(raw)) return undefined

  try {
    const url = new URL(raw)
    if (!/^socks5?h?:?$|^socks:?$/i.test(url.protocol)) return undefined
    if (!url.hostname || !isValidPort(url.port)) return undefined

    const searchData = Object.fromEntries(url.searchParams.entries())
    const name = cleanValue(url.searchParams.get('name')) ||
      cleanValue(url.hash ? decodeURIComponent(url.hash.slice(1)) : '')
    return parseFromMappedObject({
      ...searchData,
      host: url.hostname,
      port: url.port,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      name,
    }, line)
  } catch {
    return undefined
  }
}

function parseKeyValueRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  const data: Record<string, string> = {}
  const pattern = /([a-zA-Z_][\w-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;|]+)/g
  for (const match of raw.matchAll(pattern)) {
    data[match[1]] = cleanValue(match[2])
  }
  return parseFromMappedObject(data, line)
}

function parseUserInfoRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  const match = raw.match(/^([^:@\s]+)(?::([^@\s]*))?@(\[[^\]]+\]|[^:\s]+):(\d{1,5})(?:\s+(.+))?$/)
  if (!match || !isValidPort(match[4])) return undefined

  const host = match[3].replace(/^\[|\]$/g, '')
  const port = Number(match[4])
  return {
    name: cleanValue(match[5]) || createDefaultName(host, port),
    host,
    port,
    username: cleanValue(match[1]) || undefined,
    password: cleanValue(match[2]) || undefined,
    enabled: true,
    sourceLine: line,
  }
}

function findHostPortPair(columns: string[]): { hostIndex: number; portIndex: number } | undefined {
  const hostIndexes = columns
    .map((value, index) => looksLikeHost(value) ? index : -1)
    .filter(index => index >= 0)
  const portIndexes = columns
    .map((value, index) => isValidPort(value) ? index : -1)
    .filter(index => index >= 0)

  let best: { hostIndex: number; portIndex: number; score: number } | undefined
  for (const hostIndex of hostIndexes) {
    for (const portIndex of portIndexes) {
      if (hostIndex === portIndex) continue

      const distance = Math.abs(hostIndex - portIndex)
      const orderPenalty = hostIndex < portIndex ? 0 : 10
      const score = distance * 100 + orderPenalty - hostIndex
      if (!best || score < best.score) {
        best = { hostIndex, portIndex, score }
      }
    }
  }

  return best ? { hostIndex: best.hostIndex, portIndex: best.portIndex } : undefined
}

function compactParts(parts: string[]): string[] {
  return parts.map(cleanValue).filter(Boolean)
}

function parseMetadataParts(parts: string[]): {
  nameParts: string[]
  username?: string
  password?: string
  province?: string
  city?: string
  regionCode?: string
} {
  const tail = compactParts(parts)
  if (tail.length === 0) return { nameParts: [] }

  const codeIndex = tail.findIndex(isLikelyRegionCode)
  if (codeIndex >= 2) {
    const regionCode = normalizeRegionCode(tail[codeIndex])
    const leadingParts = tail.slice(0, codeIndex - 2)
    const credentialParts = leadingParts.length >= 2 ? leadingParts.slice(-2) : []
    return {
      nameParts: leadingParts.length >= 2 ? leadingParts.slice(0, -2) : leadingParts,
      username: credentialParts[0] || undefined,
      password: credentialParts[1] || undefined,
      province: tail[codeIndex - 2],
      city: tail[codeIndex - 1],
      regionCode,
    }
  }

  if (tail.length >= 4) {
    const credentialParts = tail.slice(-4, -2)
    return {
      nameParts: tail.slice(0, -4),
      username: credentialParts[0] || undefined,
      password: credentialParts[1] || undefined,
      province: tail[tail.length - 2],
      city: tail[tail.length - 1],
    }
  }

  if (tail.length >= 3) {
    const credentialParts = tail.slice(-2)
    return {
      nameParts: tail.slice(0, -2),
      username: credentialParts[0] || undefined,
      password: credentialParts[1] || undefined,
    }
  }

  return {
    nameParts: [],
    username: tail[0] || undefined,
    password: tail[1] || undefined,
  }
}

function createNodeFromColumns(columns: string[], line: number): ParsedProxyImportNode | undefined {
  const pair = findHostPortPair(columns)
  if (!pair) return undefined

  const host = columns[pair.hostIndex]
  const port = Number(columns[pair.portIndex])
  let nameParts: string[] = []
  let metadata: ReturnType<typeof parseMetadataParts> = { nameParts: [] }

  if (pair.hostIndex < pair.portIndex) {
    const beforeHost = columns.slice(0, pair.hostIndex)
    const betweenHostAndPort = columns.slice(pair.hostIndex + 1, pair.portIndex)
    const afterPort = columns.slice(pair.portIndex + 1)

    nameParts = beforeHost
    if (compactParts(afterPort).length > 0) {
      metadata = parseMetadataParts(afterPort)
    } else if (compactParts(betweenHostAndPort).length >= 2) {
      metadata = parseMetadataParts(betweenHostAndPort)
    } else if (compactParts(beforeHost).length >= 2) {
      metadata = parseMetadataParts(beforeHost)
      nameParts = []
    }
  } else {
    const beforePort = columns.slice(0, pair.portIndex)
    const betweenPortAndHost = columns.slice(pair.portIndex + 1, pair.hostIndex)
    const afterHost = columns.slice(pair.hostIndex + 1)

    nameParts = beforePort
    if (compactParts(afterHost).length > 0) {
      metadata = parseMetadataParts(afterHost)
    } else if (compactParts(betweenPortAndHost).length >= 2) {
      metadata = parseMetadataParts(betweenPortAndHost)
    } else if (compactParts(beforePort).length >= 2) {
      metadata = parseMetadataParts(beforePort)
      nameParts = []
    }
  }

  const name = compactParts([...nameParts, ...metadata.nameParts]).join(' ')
  return {
    name: name || createDefaultName(host, port),
    host,
    port,
    username: metadata.username,
    password: metadata.password,
    ...(metadata.province ? { province: metadata.province } : {}),
    ...(metadata.city ? { city: metadata.city } : {}),
    ...(metadata.regionCode ? { regionCode: metadata.regionCode } : {}),
    enabled: true,
    sourceLine: line,
  }
}

function parseColonRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  const ipv6Match = raw.match(/^\[([^\]]+)\]:(\d{1,5})(?::([^:]*)(?::(.*))?)?$/)
  if (ipv6Match && isValidPort(ipv6Match[2])) {
    const port = Number(ipv6Match[2])
    return {
      name: createDefaultName(ipv6Match[1], port),
      host: ipv6Match[1],
      port,
      username: cleanValue(ipv6Match[3]) || undefined,
      password: cleanValue(ipv6Match[4]) || undefined,
      enabled: true,
      sourceLine: line,
    }
  }

  const parts = raw.split(':').map(cleanValue)
  if (parts.length < 2 || !isValidPort(parts[1]) || !looksLikeHost(parts[0])) return undefined

  const host = parts[0]
  const port = Number(parts[1])
  return {
    name: createDefaultName(host, port),
    host,
    port,
    username: parts[2] || undefined,
    password: parts.length > 3 ? parts.slice(3).join(':') : undefined,
    enabled: true,
    sourceLine: line,
  }
}

function parseFlexibleColonRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  if (!raw.includes(':') || raw.includes('://') || raw.startsWith('[')) return undefined

  const parts = raw.split(':').map(cleanValue)
  if (parts.length < 4) return undefined
  return createNodeFromColumns(parts, line)
}

function parseDelimitedRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  const columns = splitColumns(raw)
  if (columns.length < 2) return undefined
  return createNodeFromColumns(columns, line)
}

function parseRecord(raw: string, line: number): ParsedProxyImportNode | undefined {
  return parseUrlRecord(raw, line) ||
    parseKeyValueRecord(raw, line) ||
    parseUserInfoRecord(raw, line) ||
    parseColonRecord(raw, line) ||
    parseFlexibleColonRecord(raw, line) ||
    parseDelimitedRecord(raw, line)
}

function parseTable(records: Array<{ line: number; text: string }>): ParsedProxyImportNode[] | undefined {
  if (records.length < 2) return undefined

  const headers = splitColumns(records[0].text).map(normalizeKey)
  if (!hasHeader(headers)) return undefined

  const nodes: ParsedProxyImportNode[] = []
  for (const record of records.slice(1)) {
    const values = splitColumns(record.text)
    const data: Record<string, string> = {}
    headers.forEach((header, index) => {
      data[header] = values[index]
    })
    const node = parseFromMappedObject(data, record.line)
    if (node) nodes.push(node)
  }
  return nodes.length > 0 ? nodes : undefined
}

export function parseProxyImportText(text: string): ProxyImportResult {
  const jsonNodes = parseJson(text)
  const records = splitRecords(text)
  const tableNodes = jsonNodes ? undefined : parseTable(records)
  const parsedNodes = jsonNodes || tableNodes || records
    .map(record => parseRecord(record.text, record.line))
    .filter((item): item is ParsedProxyImportNode => Boolean(item))

  const issues: ProxyImportIssue[] = []
  const recordLines = new Set(parsedNodes.map(node => node.sourceLine))

  if (!jsonNodes) {
    const ignoredLines = new Set<number>(tableNodes ? [records[0]?.line] : [])
    for (const record of records) {
      if (!ignoredLines.has(record.line) && !recordLines.has(record.line)) {
        issues.push({
          line: record.line,
          input: '',
          code: 'invalid',
          message: 'Unable to identify host and port',
        })
      }
    }
  }

  if (records.length === 0 && text.trim()) {
    issues.push({
      line: 1,
      input: '',
      code: 'invalid',
      message: 'Unable to identify host and port',
    })
  } else if (records.length === 0) {
    issues.push({
      line: 0,
      input: '',
      code: 'empty',
      message: 'Import text is empty',
    })
  }

  const seen = new Set<string>()
  const nodes: ParsedProxyImportNode[] = []
  for (const node of parsedNodes) {
    const key = `${node.host}:${node.port}:${node.username || ''}`
    if (seen.has(key)) {
      issues.push({
        line: node.sourceLine,
        input: `${node.host}:${node.port}`,
        code: 'duplicate',
        message: 'Duplicate proxy node in import text',
      })
      continue
    }
    seen.add(key)
    nodes.push(node)
  }

  return {
    nodes,
    issues,
    totalLines: records.length,
  }
}
