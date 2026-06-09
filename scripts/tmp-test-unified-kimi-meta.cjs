#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http2 = require('node:http2')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const STORE_DIR = path.join(os.homedir(), '.chat2api')
const STORE_KEY = 'chat2api-fixed-encryption-key-v1'
const DEFAULT_ENDPOINT = 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat'

function parseArgs(argv) {
  const options = {
    prompt: 'GEO优化公司推荐',
    model: 'kimi-search',
    timeout: 180,
    endpoint: DEFAULT_ENDPOINT,
    accountId: process.env.CHAT2API_KIMI_ACCOUNT_ID || '',
    cookie: process.env.KIMI_COOKIE_STR || '',
    output: '',
    rawLimit: 80,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--prompt' && next) {
      options.prompt = next
      i += 1
    } else if (arg === '--model' && next) {
      options.model = next
      i += 1
    } else if (arg === '--timeout' && next) {
      options.timeout = Number(next)
      i += 1
    } else if (arg === '--endpoint' && next) {
      options.endpoint = next
      i += 1
    } else if (arg === '--account-id' && next) {
      options.accountId = next
      i += 1
    } else if (arg === '--cookie' && next) {
      options.cookie = next
      i += 1
    } else if (arg === '--output' && next) {
      options.output = path.resolve(next)
      i += 1
    } else if (arg === '--raw-limit' && next) {
      options.rawLimit = Number(next)
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error('--timeout must be a positive number of seconds')
  }
  if (!Number.isFinite(options.rawLimit) || options.rawLimit < 0) {
    throw new Error('--raw-limit must be a non-negative number')
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  node scripts/tmp-test-unified-kimi-meta.cjs [options]

Options:
  --prompt <text>       Prompt to send. Default: GEO优化公司推荐
  --model <id>          Unified proxy style Kimi model. Default: kimi-search
  --timeout <seconds>   Request timeout. Default: 180
  --endpoint <url>      Kimi Connect endpoint. Default: ${DEFAULT_ENDPOINT}
  --account-id <id>     Use a specific Chat2API Kimi account id
  --cookie <cookie>     Optional Kimi cookie string. Env: KIMI_COOKIE_STR
  --output <path>       Save sanitized raw event summary JSON
  --raw-limit <n>       Max raw event summaries to save. Default: 80
`)
}

function runParent() {
  let electronPath
  try {
    electronPath = require('electron')
  } catch {
    throw new Error('Cannot locate Electron. Run npm install first.')
  }

  const result = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CHAT2API_TMP_UNIFIED_KIMI_CHILD: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      CHAT2API_DISABLE_BACKGROUND_NETWORKING: 'true',
    },
  })

  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

function tokenLooksPlain(value) {
  return /^Bearer\s+/i.test(value) || /^eyJ[^.]+\.[^.]+\.[^.]+$/.test(value) || value.length > 900
}

async function loadKimiAccount(options) {
  const { app, safeStorage } = require('electron')
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('metrics-recording-only')
  app.commandLine.appendSwitch('no-first-run')
  app.setName('chat2api')
  try {
    app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'chat2api'))
  } catch {
    // safeStorage can still use the app name if Electron has already locked userData.
  }
  await app.whenReady()

  const Store = (await import('electron-store')).default
  const store = new Store({
    name: 'data',
    cwd: STORE_DIR,
    encryptionKey: STORE_KEY,
  })

  const accounts = store.get('accounts') || []
  const kimiAccounts = accounts.filter(account => account.providerId === 'kimi')
  const account = options.accountId
    ? kimiAccounts.find(item => item.id === options.accountId)
    : kimiAccounts.find(item => item.status === 'active') || kimiAccounts[0]

  if (!account) {
    throw new Error('No Kimi account found in ~/.chat2api/data.json')
  }

  const encryptedToken = account.credentials?.token || account.credentials?.accessToken || account.credentials?.refreshToken || ''
  if (!encryptedToken) {
    throw new Error(`Kimi account "${account.name || account.id}" has no token credential`)
  }

  let token = encryptedToken
  if (!tokenLooksPlain(encryptedToken)) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron safeStorage is not available, cannot decrypt the stored Kimi token')
    }
    token = safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'))
  }

  return {
    accountId: account.id,
    accountName: account.name || account.id,
    token: token.replace(/^Bearer\s+/i, '').trim(),
  }
}

function resolveKimiScenario(model) {
  return model.toLowerCase().includes('k2.6') ? 'SCENARIO_K2D6' : 'SCENARIO_K2D5'
}

function createUnifiedKimiPayload(options) {
  const scenario = resolveKimiScenario(options.model)
  const payload = {
    chat_id: '',
    scenario,
    message: {
      role: 'user',
      blocks: [{ text: { content: options.prompt } }],
      scenario,
    },
    options: {
      thinking: options.model.toLowerCase().includes('thinking'),
    },
  }

  if (options.model.toLowerCase().includes('search')) {
    payload.tools = [{ type: 'TOOL_TYPE_SEARCH', search: {} }]
  }

  return payload
}

function encodeConnectFrame(payload) {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.alloc(5 + jsonBuffer.length)
  frame.writeUInt8(0, 0)
  frame.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frame, 5)
  return frame
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function pickPositiveInteger(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
    if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return Number(value)
  }
  return undefined
}

function isCitationReference(reference) {
  return reference?.type === 2
    || reference?.type === 'CITE'
    || reference?.type === 'REFERENCE_TYPE_CITE'
}

function normalizeSearchResult(raw, fallbackIndex) {
  if (!raw || typeof raw !== 'object') return null

  const contentValue = raw.content?.case === 'search'
    ? raw.content.value
    : raw.content?.value
  const source = contentValue || raw.search || raw.value || raw
  const base = source.base || source.page || source.webPage || source.web_page || source
  const url = pickString(
    source.url,
    source.uri,
    source.link,
    source.sourceUrl,
    source.source_url,
    base.url,
    base.uri,
    base.link,
    base.sourceUrl,
    base.source_url,
  )

  if (!url) return null

  const index = pickPositiveInteger(
    source.index,
    source.cite_index,
    source.citeIndex,
    source.ref_index,
    source.refIndex,
    base.index,
    base.cite_index,
    base.citeIndex,
    base.ref_index,
    base.refIndex,
  ) || fallbackIndex

  const title = pickString(source.title, source.name, base.title, base.name, base.siteName, base.site_name) || url
  const snippet = pickString(source.snippet, source.summary, source.content, base.snippet, base.summary, base.content)
  const siteName = pickString(source.siteName, source.site_name, base.siteName, base.site_name)
  const iconUrl = pickString(source.iconUrl, source.icon_url, source.siteIcon, source.site_icon, base.iconUrl, base.icon_url, base.siteIcon, base.site_icon)

  return {
    index,
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(siteName ? { siteName } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  }
}

class KimiMetaCollector {
  constructor(rawLimit) {
    this.rawLimit = rawLimit
    this.answerParts = []
    this.reasoningParts = []
    this.searchKeywords = []
    this.searchResults = []
    this.chatId = ''
    this.messageId = ''
    this.shareCandidates = []
    this.toolArgsParts = []
    this.toolSearchContents = []
    this.eventStats = new Map()
    this.rawEvents = []
    this.jsonEvents = 0
    this.invalidFrames = 0
    this.frames = 0
  }

  addEventStat(data) {
    const key = [
      data.op ? `op:${data.op}` : '',
      data.mask ? `mask:${data.mask}` : '',
      data.event ? 'event' : '',
      data.block ? 'block' : '',
      data.message ? 'message' : '',
      data.chat ? 'chat' : '',
      data.done !== undefined ? 'done' : '',
      data.result ? 'result' : '',
      data.error ? 'error' : '',
    ].filter(Boolean).join(' ') || Object.keys(data).sort().slice(0, 6).join(',')
    this.eventStats.set(key, (this.eventStats.get(key) || 0) + 1)
  }

  saveRawEvent(data) {
    if (this.rawEvents.length >= this.rawLimit) return
    this.rawEvents.push({
      keys: Object.keys(data).sort(),
      op: data.op,
      mask: data.mask,
      chatId: data.chat?.id,
      messageId: data.message?.id,
      messageRole: data.message?.role,
      blockKeys: data.block && typeof data.block === 'object' ? Object.keys(data.block).sort() : undefined,
      contentCase: data.block?.content?.case,
      textSample: pickString(data.block?.text?.content, data.result?.choices?.[0]?.delta?.content)?.slice(0, 120),
      toolArgsSample: typeof data.block?.tool?.args === 'string' ? data.block.tool.args.slice(0, 120) : undefined,
      toolContentCount: Array.isArray(data.block?.tool?.contents) ? data.block.tool.contents.length : undefined,
      hasRefs: Boolean(data.refs || data.message?.refs),
      hasReferences: Boolean(data.references || data.message?.references),
      hasSearchBlock: data.block?.content?.case === 'search'
        || Boolean(data.block?.search)
        || Boolean(data.block?.tool?.contents),
      hasShareLikeField: JSON.stringify(data).toLowerCase().includes('share'),
    })
  }

  nextAvailableCitationIndex() {
    const used = new Set(this.searchResults.map(item => item.index))
    let index = 1
    while (used.has(index)) index += 1
    return index
  }

  addSearchKeywords(keywords) {
    for (const item of asArray(keywords)) {
      const keyword = typeof item === 'string'
        ? item
        : pickString(item?.keyword, item?.query, item?.text, item?.title, item?.content)
      if (keyword && !this.searchKeywords.includes(keyword)) {
        this.searchKeywords.push(keyword)
      }
    }
  }

  addSearchResults(results) {
    for (const raw of asArray(results)) {
      const citation = normalizeSearchResult(raw, this.nextAvailableCitationIndex())
      if (!citation) continue
      const existingIndex = this.searchResults.findIndex(item => item.url === citation.url)
      if (existingIndex >= 0) {
        this.searchResults[existingIndex] = {
          ...this.searchResults[existingIndex],
          ...citation,
          index: this.searchResults[existingIndex].index || citation.index,
        }
      } else {
        this.searchResults.push(citation)
      }
    }
  }

  collectSearchBlock(block) {
    if (!block || typeof block !== 'object') return
    const search = block.content?.case === 'search'
      ? block.content.value
      : block.search || block
    this.addSearchKeywords(search?.keywords ?? search?.keyword ?? search?.queries ?? search?.query ?? search?.searchQueries)
    this.addSearchResults(search?.webPages ?? search?.web_pages ?? search?.pages ?? search?.results)
    for (const step of asArray(search?.steps)) {
      this.addSearchKeywords(step?.keywords ?? step?.keyword ?? step?.queries ?? step?.query)
      this.addSearchResults(step?.webPages ?? step?.web_pages ?? step?.pages ?? step?.results)
    }
  }

  collectRefs(refs) {
    if (!refs || typeof refs !== 'object') return
    this.addSearchResults(refs.usedSearchChunks)
    this.addSearchResults(refs.used_search_chunks)
    this.addSearchResults(refs.searchChunks)
    this.addSearchResults(refs.search_chunks)
  }

  collectReferences(references) {
    for (const reference of asArray(references)) {
      if (!isCitationReference(reference)) continue
      for (const item of asArray(reference.items ?? reference.item)) {
        if (item?.content?.case === 'search') {
          this.addSearchResults(item.content.value)
        } else {
          this.addSearchResults(item?.search ?? item?.value)
        }
      }
    }
  }

  collectShareCandidates(value, pathParts = []) {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...pathParts, key]
      const keyLower = key.toLowerCase()
      if (typeof child === 'string') {
        const childLower = child.toLowerCase()
        if (keyLower.includes('share') || /https?:\/\/[^\s"]+\/share[/?#]/i.test(child) || /\/share[/?#]/i.test(childLower)) {
          this.shareCandidates.push({ path: nextPath.join('.'), value: child.slice(0, 300) })
        }
      } else if (child && typeof child === 'object') {
        this.collectShareCandidates(child, nextPath)
      }
    }
  }

  collectText(data) {
    const resultDelta = data.result?.choices?.[0]?.delta
    const content = pickString(
      data.block?.text?.content,
      resultDelta?.content,
      data.result?.message?.blocks?.[0]?.text?.content,
    )
    if (content) {
      const isThinking = data.mask?.includes('block.think')
        || data.block?.text?.flags === 'thinking'
        || resultDelta?.reasoning_content
      if (isThinking) this.reasoningParts.push(content)
      else this.answerParts.push(content)
    }
    const reasoning = pickString(resultDelta?.reasoning_content, data.block?.think?.content)
    if (reasoning) this.reasoningParts.push(reasoning)
  }

  collectToolBlock(block) {
    const tool = block?.tool
    if (!tool || typeof tool !== 'object') return

    if (typeof tool.args === 'string' && tool.args) {
      this.toolArgsParts.push(tool.args)
    }

    const contents = asArray(tool.contents)
    for (const item of contents) {
      const searchResult = item?.searchResult
        ?? item?.search_result
        ?? item?.result
        ?? item
      const citation = normalizeSearchResult(searchResult, this.nextAvailableCitationIndex())
      if (citation) {
        this.addSearchResults(citation)
        this.toolSearchContents.push(citation)
      }

      this.addSearchKeywords(
        item?.query
        ?? item?.keyword
        ?? item?.searchQuery
        ?? item?.search_query
        ?? searchResult?.query
        ?? searchResult?.keyword
        ?? searchResult?.searchQuery
        ?? searchResult?.search_query,
      )
    }
  }

  collect(data) {
    this.jsonEvents += 1
    this.addEventStat(data)
    this.saveRawEvent(data)
    this.collectShareCandidates(data)
    this.collectText(data)
    this.collectToolBlock(data.block)

    if (data.chat?.id && !this.chatId) this.chatId = data.chat.id
    if (data.message?.id && data.message?.role === 'assistant' && !this.messageId) this.messageId = data.message.id

    this.collectSearchBlock(data.block)
    if (data.event?.value) this.collectSearchBlock(data.event.value)
    if (data.ref) this.addSearchResults(data.ref.search ?? data.ref)
    if (data.refs) this.collectRefs(data.refs)
    if (data.references) this.collectReferences(data.references)

    if (data.message) {
      this.collectRefs(data.message.refs)
      this.collectReferences(data.message.references)
      for (const block of asArray(data.message.blocks)) {
        this.collectSearchBlock(block)
      }
    }
  }

  summary(options, account) {
    const toolArgsText = this.toolArgsParts.join('')
    let parsedToolArgs = null
    if (toolArgsText.trim()) {
      try {
        parsedToolArgs = JSON.parse(toolArgsText)
      } catch {
        parsedToolArgs = toolArgsText.trim()
      }
    }

    return {
      prompt: options.prompt,
      model: options.model,
      account: {
        id: account.accountId,
        name: account.accountName,
      },
      chatId: this.chatId,
      messageId: this.messageId,
      answer: this.answerParts.join(''),
      reasoning: this.reasoningParts.join(''),
      searchResults: {
        keywords: this.searchKeywords,
        webPages: [...this.searchResults].sort((a, b) => a.index - b.index),
      },
      searchTool: {
        args: parsedToolArgs,
        contents: this.toolSearchContents,
      },
      shareCandidates: this.shareCandidates,
      stats: {
        frames: this.frames,
        jsonEvents: this.jsonEvents,
        invalidFrames: this.invalidFrames,
        eventStats: Object.fromEntries([...this.eventStats.entries()].sort((a, b) => b[1] - a[1])),
      },
      rawEvents: this.rawEvents,
    }
  }
}

function requestKimi(options, account) {
  const endpoint = new URL(options.endpoint)
  const payload = createUnifiedKimiPayload(options)
  const body = encodeConnectFrame(payload)
  const collector = new KimiMetaCollector(options.rawLimit)

  return new Promise((resolve, reject) => {
    const client = http2.connect(`${endpoint.protocol}//${endpoint.host}`)
    const timeout = setTimeout(() => {
      client.close()
      reject(new Error(`Kimi request timed out after ${options.timeout}s`))
    }, options.timeout * 1000)

    client.once('error', reject)

    const headers = {
      ':method': 'POST',
      ':path': `${endpoint.pathname}${endpoint.search}`,
      ':authority': endpoint.host,
      authorization: `Bearer ${account.token}`,
      'connect-protocol-version': '1',
      'content-type': 'application/connect+json',
      origin: `${endpoint.protocol}//${endpoint.host}`,
      referer: `${endpoint.protocol}//${endpoint.host}/`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      'x-msh-platform': 'web',
      'x-msh-device-id': crypto.randomUUID().replace(/-/g, ''),
      'accept': '*/*',
    }
    if (options.cookie) headers.cookie = options.cookie

    const req = client.request(headers)
    let statusCode = 0
    let responseHeaders = {}
    let buffer = Buffer.alloc(0)

    req.once('response', headers => {
      responseHeaders = headers
      statusCode = Number(headers[':status'] || 0)
    })

    req.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5) {
        const length = buffer.readUInt32BE(1)
        if (buffer.length < 5 + length) break
        const payload = buffer.slice(5, 5 + length)
        buffer = buffer.slice(5 + length)
        collector.frames += 1
        const text = payload.toString('utf8')
        if (!text.trim()) continue
        try {
          collector.collect(JSON.parse(text))
        } catch {
          collector.invalidFrames += 1
        }
      }
    })

    req.once('error', error => {
      clearTimeout(timeout)
      client.close()
      reject(error)
    })

    req.once('end', () => {
      clearTimeout(timeout)
      client.close()
      if (statusCode !== 200) {
        reject(new Error(`Kimi request failed: HTTP ${statusCode || 'unknown'} ${JSON.stringify(responseHeaders)}`))
        return
      }
      resolve(collector.summary(options, account))
    })

    req.end(body)
  })
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(os.tmpdir(), `chat2api-unified-kimi-meta-${stamp}.json`)
}

function printSummary(summary, outputPath) {
  console.log(`[Chat2API] Loaded Kimi account: ${summary.account.name} (${summary.account.id})`)
  console.log(`[Kimi] model=${summary.model}`)
  console.log(`[Kimi] prompt=${summary.prompt}`)
  console.log(`[Kimi] chat_id=${summary.chatId || '(not found)'}`)
  console.log(`[Kimi] assistant_message_id=${summary.messageId || '(not found)'}`)
  console.log(`[Kimi] frames=${summary.stats.frames} json_events=${summary.stats.jsonEvents} invalid_frames=${summary.stats.invalidFrames}`)
  console.log('')
  console.log('--- answer preview ---')
  console.log(summary.answer ? summary.answer.slice(0, 2000) : '(empty)')
  if (summary.answer.length > 2000) console.log(`... (${summary.answer.length} chars total)`)
  if (summary.reasoning) {
    console.log('')
    console.log('--- reasoning preview ---')
    console.log(summary.reasoning.slice(0, 1000))
    if (summary.reasoning.length > 1000) console.log(`... (${summary.reasoning.length} chars total)`)
  }
  console.log('')
  console.log('--- search keywords ---')
  console.log(summary.searchResults.keywords.length ? JSON.stringify(summary.searchResults.keywords, null, 2) : '(none)')
  console.log('')
  console.log('--- search tool args ---')
  console.log(summary.searchTool.args ? JSON.stringify(summary.searchTool.args, null, 2).slice(0, 2000) : '(none)')
  console.log(`[Kimi] search tool content items=${summary.searchTool.contents.length}`)
  console.log('')
  console.log('--- citations/web pages ---')
  if (summary.searchResults.webPages.length) {
    for (const item of summary.searchResults.webPages) {
      console.log(`${item.index}. ${item.title}`)
      console.log(`   ${item.url}`)
      if (item.snippet) console.log(`   ${item.snippet.slice(0, 220)}`)
    }
  } else {
    console.log('(none)')
  }
  console.log('')
  console.log('--- share-like fields in stream ---')
  console.log(summary.shareCandidates.length ? JSON.stringify(summary.shareCandidates, null, 2) : '(none)')
  console.log('')
  console.log('--- top event shapes ---')
  for (const [key, count] of Object.entries(summary.stats.eventStats).slice(0, 12)) {
    console.log(`${count}x ${key}`)
  }
  console.log('')
  console.log(`[Kimi] sanitized raw event summary saved to: ${outputPath}`)
}

async function runChild(options) {
  const { app } = require('electron')
  try {
    const account = await loadKimiAccount(options)
    const outputPath = options.output || defaultOutputPath()
    const summary = await requestKimi(options, account)
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2))
    printSummary(summary, outputPath)
  } finally {
    app.quit()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.env.CHAT2API_TMP_UNIFIED_KIMI_CHILD === '1') {
    await runChild(options)
  } else {
    runParent()
  }
}

main().catch(error => {
  console.error(`[tmp-test-unified-kimi-meta] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
