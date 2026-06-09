#!/usr/bin/env node

const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CHILD_ENV = 'CHAT2API_QWEN2API_PROBE_CHILD'
const STORE_DIR = path.join(os.homedir(), '.chat2api')
const STORE_KEY = 'chat2api-fixed-encryption-key-v1'

function printHelp() {
  console.log(`Usage:
  node scripts/probe-qwen2api.cjs [options]

Options:
  --base-url <url>       qwen2API base URL. Default: QWEN2API_BASE_URL or http://127.0.0.1:7860
  --admin-key <key>      qwen2API ADMIN_KEY. Default: QWEN2API_ADMIN_KEY or ADMIN_KEY or admin
  --api-key <key>        Client API key for /v1 endpoints. Default: same as --admin-key
  --account-id <id>      Use a specific Chat2API account id
  --provider <id>        Chat2API provider id: auto, qwen-ai, or qwen. Default: auto
  --model <id>           Model for chat test. Default: qwen3.6-plus
  --prompt <text>        Prompt for chat test
  --timeout <ms>         HTTP timeout in milliseconds. Default: 120000
  --email <email>        Email label used when injecting the account into qwen2API
  --skip-add-account     Do not POST the Chat2API token into qwen2API
  --skip-chat            Only check health/status/models, do not send a chat request
  --dry-run              Only verify Chat2API credential loading
  -h, --help             Show this help

Environment:
  QWEN2API_BASE_URL, QWEN2API_ADMIN_KEY, QWEN2API_API_KEY,
  CHAT2API_QWEN_ACCOUNT_ID, CHAT2API_QWEN_PROVIDER
`)
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.QWEN2API_BASE_URL || 'http://127.0.0.1:7860',
    adminKey: process.env.QWEN2API_ADMIN_KEY || process.env.ADMIN_KEY || 'admin',
    apiKey: process.env.QWEN2API_API_KEY || '',
    accountId: process.env.CHAT2API_QWEN_ACCOUNT_ID || '',
    provider: process.env.CHAT2API_QWEN_PROVIDER || 'auto',
    model: 'qwen3.6-plus',
    prompt: '请用一句话说明你是谁，并列出你当前可用的主要能力。',
    timeoutMs: 120000,
    email: '',
    skipAddAccount: false,
    skipChat: false,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--base-url' && next) {
      options.baseUrl = next
      i += 1
    } else if (arg === '--admin-key' && next) {
      options.adminKey = next
      i += 1
    } else if (arg === '--api-key' && next) {
      options.apiKey = next
      i += 1
    } else if ((arg === '--account-id' || arg === '--chat2api-account-id') && next) {
      options.accountId = next
      i += 1
    } else if (arg === '--provider' && next) {
      options.provider = next
      i += 1
    } else if (arg === '--model' && next) {
      options.model = next
      i += 1
    } else if (arg === '--prompt' && next) {
      options.prompt = next
      i += 1
    } else if (arg === '--timeout' && next) {
      options.timeoutMs = Number(next)
      i += 1
    } else if (arg === '--email' && next) {
      options.email = next
      i += 1
    } else if (arg === '--skip-add-account') {
      options.skipAddAccount = true
    } else if (arg === '--skip-chat') {
      options.skipChat = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, '')
  options.apiKey = options.apiKey || options.adminKey

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds')
  }
  if (!['auto', 'qwen-ai', 'qwen'].includes(options.provider)) {
    throw new Error('--provider must be one of: auto, qwen-ai, qwen')
  }

  return options
}

function runParent(options) {
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
      [CHILD_ENV]: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  })

  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

function looksLikeSafeStorageBase64(value) {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}

function maskId(value) {
  if (!value || value.length <= 10) {
    return value || ''
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function safeEmail(account) {
  const raw = String(account.id || account.name || 'qwen-ai').replace(/[^a-zA-Z0-9._-]+/g, '_')
  return `chat2api_${raw.slice(0, 48)}@local`
}

function decryptCredential(value, safeStorage) {
  if (!value) {
    return ''
  }
  if (safeStorage.isEncryptionAvailable() && looksLikeSafeStorageBase64(value)) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}

async function loadQwenAccount(options) {
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
    // Best effort: safeStorage can still use the app name above.
  }
  await app.whenReady()

  const Store = (await import('electron-store')).default
  const store = new Store({
    name: 'data',
    cwd: STORE_DIR,
    encryptionKey: STORE_KEY,
  })

  const allAccounts = store.get('accounts') || []
  const qwenAccounts = allAccounts.filter((account) => ['qwen-ai', 'qwen'].includes(account.providerId))

  let account
  if (options.accountId) {
    account = qwenAccounts.find((item) => item.id === options.accountId)
  } else {
    const providerOrder = options.provider === 'auto' ? ['qwen-ai', 'qwen'] : [options.provider]
    for (const providerId of providerOrder) {
      account =
        qwenAccounts.find((item) => item.providerId === providerId && item.status === 'active') ||
        qwenAccounts.find((item) => item.providerId === providerId)
      if (account) {
        break
      }
    }
  }

  if (!account) {
    throw new Error('No Chat2API Qwen account found in ~/.chat2api/data.json')
  }

  const credentials = {}
  for (const [key, value] of Object.entries(account.credentials || {})) {
    credentials[key] = decryptCredential(value, safeStorage)
  }

  if (account.providerId === 'qwen') {
    throw new Error(
      `Selected Chat2API account "${account.name || account.id}" is provider "qwen", which stores tongyi_sso_ticket for www.qianwen.com. qwen2API expects a chat.qwen.ai JWT token. Configure/use a "qwen-ai" account instead.`
    )
  }

  const token = credentials.token || ''
  if (!token) {
    throw new Error(`Chat2API qwen-ai account "${account.name || account.id}" has no token credential`)
  }

  return {
    id: account.id,
    name: account.name || account.id,
    providerId: account.providerId,
    token,
    cookies: credentials.cookies || '',
    email: options.email || safeEmail(account),
  }
}

async function fetchJson(options, method, pathname, { auth, body, timeoutMs } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs || options.timeoutMs)
  try {
    const headers = {
      Accept: 'application/json',
    }
    if (auth) {
      headers.Authorization = `Bearer ${auth}`
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${options.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // Keep non-JSON body for diagnostics.
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      text,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function assertOk(step, result) {
  if (result.ok) {
    return
  }
  const detail = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
  throw new Error(`${step} failed: HTTP ${result.status} ${detail || ''}`.trim())
}

function summarizeModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : []
  return models.slice(0, 12).map((item) => item.id || item.name || String(item))
}

function extractAssistantText(payload) {
  const message = payload?.choices?.[0]?.message
  if (typeof message?.content === 'string') {
    return message.content
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

async function runProbe(options, account) {
  console.log(`[qwen2API] baseUrl=${options.baseUrl}`)

  const health = await fetchJson(options, 'GET', '/healthz')
  assertOk('health check', health)
  console.log(`[qwen2API] health=${JSON.stringify(health.data)}`)

  if (!options.skipAddAccount) {
    const addAccount = await fetchJson(options, 'POST', '/api/admin/accounts', {
      auth: options.adminKey,
      body: {
        token: account.token,
        cookies: account.cookies,
        email: account.email,
        username: `Chat2API ${account.name}`,
      },
    })
    assertOk('add account', addAccount)
    if (addAccount.data?.ok === false) {
      throw new Error(`add account failed: ${addAccount.data.error || JSON.stringify(addAccount.data)}`)
    }
    console.log(`[qwen2API] account injected as ${addAccount.data?.email || account.email}`)
  }

  const status = await fetchJson(options, 'GET', '/api/admin/status', { auth: options.adminKey })
  assertOk('admin status', status)
  console.log(`[qwen2API] accounts=${JSON.stringify(status.data?.accounts || {})}`)

  const models = await fetchJson(options, 'GET', '/v1/models', { auth: options.apiKey })
  assertOk('list models', models)
  const modelIds = summarizeModels(models.data)
  console.log(`[qwen2API] models(${modelIds.length} shown)=${modelIds.join(', ') || '(none)'}`)

  if (options.skipChat) {
    return
  }

  const chat = await fetchJson(options, 'POST', '/v1/chat/completions', {
    auth: options.apiKey,
    body: {
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      stream: false,
      enable_thinking: false,
    },
  })
  assertOk('chat completion', chat)

  const content = extractAssistantText(chat.data)
  console.log('--- qwen2API reply begin ---')
  console.log(content || JSON.stringify(chat.data, null, 2))
  console.log('--- qwen2API reply end ---')
  if (chat.data?.usage) {
    console.log(`[qwen2API] usage=${JSON.stringify(chat.data.usage)}`)
  }
}

async function runChild(options) {
  const { app } = require('electron')
  try {
    const account = await loadQwenAccount(options)
    console.log(
      `[Chat2API] loaded account=${account.name} id=${maskId(account.id)} provider=${account.providerId} tokenLength=${account.token.length} cookies=${account.cookies ? 'yes' : 'no'}`
    )

    if (options.dryRun) {
      console.log('[probe] dry run complete; no qwen2API request was sent.')
      return
    }

    await runProbe(options, account)
  } finally {
    app.quit()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!process.env[CHILD_ENV]) {
    runParent(options)
    return
  }
  await runChild(options)
}

main().catch((error) => {
  console.error(`[probe] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
