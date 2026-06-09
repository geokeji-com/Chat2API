#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DEFAULT_REPO_URL = 'https://github.com/pooraddyy/p2d-kimi.git'
const DEFAULT_REPO_DIR = path.join(os.tmpdir(), 'p2d-kimi')
const STORE_DIR = path.join(os.homedir(), '.chat2api')
const STORE_KEY = 'chat2api-fixed-encryption-key-v1'

function parseArgs(argv) {
  const options = {
    prompt: 'GEO优化公司推荐',
    model: 'kimi',
    timeout: '120',
    useSearch: true,
    repoDir: process.env.P2D_KIMI_DIR || DEFAULT_REPO_DIR,
    accountId: process.env.CHAT2API_KIMI_ACCOUNT_ID || '',
    dryRun: false,
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
      options.timeout = next
      i += 1
    } else if (arg === '--repo-dir' && next) {
      options.repoDir = path.resolve(next)
      i += 1
    } else if (arg === '--account-id' && next) {
      options.accountId = next
      i += 1
    } else if (arg === '--no-search') {
      options.useSearch = false
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  node scripts/tmp-test-p2d-kimi.cjs [options]

Options:
  --prompt <text>       Prompt to send. Default: GEO优化公司推荐
  --model <id>          p2d-kimi kimiplus_id/model. Default: kimi
  --timeout <seconds>   HTTP timeout. Default: 120
  --repo-dir <path>     Local p2d-kimi checkout. Default: ${DEFAULT_REPO_DIR}
  --account-id <id>     Use a specific Chat2API Kimi account id
  --no-search           Disable p2d-kimi use_search
  --dry-run             Only verify repo and token loading, do not call Kimi
`)
}

function ensureP2dKimiRepo(repoDir) {
  const clientFile = path.join(repoDir, 'p2dkimi', 'client.py')
  if (fs.existsSync(clientFile)) {
    return
  }

  if (fs.existsSync(repoDir)) {
    throw new Error(`${repoDir} exists but does not look like p2d-kimi`)
  }

  console.log(`[p2d-kimi] Cloning ${DEFAULT_REPO_URL} -> ${repoDir}`)
  const result = spawnSync('git', ['clone', '--depth', '1', DEFAULT_REPO_URL, repoDir], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`git clone failed with exit code ${result.status}`)
  }
}

function runParent(options) {
  ensureP2dKimiRepo(options.repoDir)

  let electronPath
  try {
    electronPath = require('electron')
  } catch (error) {
    throw new Error('Cannot locate Electron. Run npm install first.')
  }

  const result = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CHAT2API_TMP_P2D_KIMI_CHILD: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  })

  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}

function tokenLooksPlain(value) {
  return /^eyJ[^.]+\.[^.]+\.[^.]+$/.test(value) || value.length > 900
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
    // The path can only be set before app readiness; if Electron has already locked it in,
    // safeStorage still has a chance to use the app name above.
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
    token,
  }
}

function pythonCode() {
  return String.raw`
import json
import os
import sys
from p2dkimi import KimiClient

token = os.environ["KIMI_TOKEN"]
prompt = os.environ["KIMI_PROMPT"]
model = os.environ.get("KIMI_MODEL", "kimi")
timeout = int(os.environ.get("KIMI_TIMEOUT", "120"))
use_search = os.environ.get("KIMI_USE_SEARCH", "1") == "1"

client = KimiClient(token=token, model=model, timeout=timeout)

print(f"[p2d-kimi] model={model} use_search={use_search} timeout={timeout}s")
print(f"[p2d-kimi] prompt={prompt}")
print("--- reply begin ---", flush=True)

chars = 0
try:
    for chunk in client.stream(prompt, use_search=use_search):
        chars += len(chunk)
        print(chunk, end="", flush=True)
    print("\n--- reply end ---", flush=True)
    print(json.dumps({"chat_id": client.chat_id, "chars": chars}, ensure_ascii=False), flush=True)
except Exception as exc:
    print("\n--- p2d-kimi error ---", file=sys.stderr, flush=True)
    print(f"{type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    raise
`
}

async function runChild(options) {
  const { app } = require('electron')
  try {
    ensureP2dKimiRepo(options.repoDir)
    const account = await loadKimiAccount(options)
    console.log(`[Chat2API] Loaded Kimi account: ${account.accountName} (${account.accountId})`)
    console.log(`[Chat2API] Token loaded: yes, length=${account.token.length}`)

    if (options.dryRun) {
      console.log('[p2d-kimi] Dry run complete; no request was sent.')
      return
    }

    const env = {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${options.repoDir}${path.delimiter}${process.env.PYTHONPATH}`
        : options.repoDir,
      KIMI_TOKEN: account.token,
      KIMI_PROMPT: options.prompt,
      KIMI_MODEL: options.model,
      KIMI_TIMEOUT: options.timeout,
      KIMI_USE_SEARCH: options.useSearch ? '1' : '0',
    }

    const result = spawnSync('python3', ['-u', '-c', pythonCode()], {
      stdio: 'inherit',
      env,
    })

    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      process.exitCode = result.status || 1
    }
  } finally {
    app.quit()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.env.CHAT2API_TMP_P2D_KIMI_CHILD === '1') {
    await runChild(options)
  } else {
    runParent(options)
  }
}

main().catch(error => {
  console.error(`[tmp-test-p2d-kimi] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
