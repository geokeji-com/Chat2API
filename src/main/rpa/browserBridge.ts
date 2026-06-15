import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  RpaBrowser,
  RpaBrowserConnection,
  RpaConnectBrowserOptions,
  RpaLaunchBrowserOptions,
  RpaTarget,
} from '../../shared/rpa'

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 9222
const DISCOVERY_PORT_START = 9222
const DISCOVERY_PORT_END = 9230

interface ResolveTargetOptions {
  url: string
  browser?: RpaBrowser
  port?: number
}

export class BrowserBridge {
  private host = DEFAULT_HOST
  private port = DEFAULT_PORT
  private launchedProcess: ChildProcessWithoutNullStreams | null = null
  private profileDir: string | undefined

  async launchBrowser(options: RpaLaunchBrowserOptions = {}): Promise<RpaBrowserConnection> {
    const browser = options.browser || 'chrome'
    const port = options.port || DEFAULT_PORT
    const executable = resolveBrowserExecutable(browser)

    if (!executable) {
      return {
        connected: false,
        host: DEFAULT_HOST,
        port,
        error: `${browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} executable was not found`,
      }
    }

    const profileDir = join(homedir(), '.chat2api', 'rpa-browser-profile', browser)
    mkdirSync(profileDir, { recursive: true })

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      options.url || 'about:blank',
    ]

    this.launchedProcess = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
    }) as ChildProcessWithoutNullStreams
    this.launchedProcess.on('error', (error) => {
      console.error('[RPA] Failed to launch controlled browser:', error)
    })
    this.launchedProcess.unref()
    this.profileDir = profileDir

    const connected = await this.waitForConnection({ host: DEFAULT_HOST, port }, 15000)
    return {
      ...connected,
      browser,
      profileDir,
    }
  }

  async connectBrowser(options: RpaConnectBrowserOptions = {}): Promise<RpaBrowserConnection> {
    return this.waitForConnection({
      host: options.host || DEFAULT_HOST,
      port: options.port || DEFAULT_PORT,
    }, 5000)
  }

  async discoverBrowser(preferredPort?: number): Promise<RpaBrowserConnection | null> {
    const ports = Array.from(new Set([
      ...(preferredPort ? [preferredPort] : []),
      ...Array.from(
        { length: DISCOVERY_PORT_END - DISCOVERY_PORT_START + 1 },
        (_, index) => DISCOVERY_PORT_START + index,
      ),
    ]))

    for (const port of ports) {
      const result = await this.waitForConnection({ host: DEFAULT_HOST, port }, 600)
      if (result.connected) {
        return result
      }
    }

    return null
  }

  async resolveOrOpenTarget(options: ResolveTargetOptions): Promise<{
    connection: RpaBrowserConnection
    target: RpaTarget
    opened: boolean
  }> {
    const desiredUrl = normalizeTargetUrl(options.url)
    const discovered = await this.discoverBrowser(options.port)
    const connection = discovered || await this.launchBrowser({
      browser: options.browser || 'chrome',
      port: options.port || DEFAULT_PORT,
      url: desiredUrl,
    })

    if (!connection.connected) {
      throw new Error(connection.error || 'Unable to connect to a Chrome DevTools browser')
    }

    let target = await this.findTargetForUrl(desiredUrl)
    let opened = false

    if (!target) {
      target = await this.openTarget(desiredUrl)
      opened = true
    }

    await this.waitForNavigableTarget(target.id, desiredUrl, 15000).catch(() => undefined)
    target = await this.getTarget(target.id) || target

    return { connection, target, opened }
  }

  async listTargets(): Promise<RpaTarget[]> {
    const targets = await this.fetchJson<any[]>('/json/list')
    return targets
      .filter((target) => target.type === 'page')
      .map((target) => ({
        id: String(target.id),
        type: String(target.type || ''),
        title: String(target.title || ''),
        url: String(target.url || ''),
        webSocketDebuggerUrl: target.webSocketDebuggerUrl ? String(target.webSocketDebuggerUrl) : undefined,
      }))
  }

  async getTarget(targetId: string): Promise<RpaTarget | undefined> {
    const targets = await this.listTargets()
    return targets.find((target) => target.id === targetId)
  }

  async openTarget(url: string): Promise<RpaTarget> {
    const path = `/json/new?${encodeURIComponent(url)}`
    const target = await this.fetchJson<any>(path, { method: 'PUT' })
      .catch(() => this.fetchJson<any>(path))
    return {
      id: String(target.id),
      type: String(target.type || 'page'),
      title: String(target.title || ''),
      url: String(target.url || url),
      webSocketDebuggerUrl: target.webSocketDebuggerUrl ? String(target.webSocketDebuggerUrl) : undefined,
    }
  }

  getConnectionInfo(): RpaBrowserConnection {
    return {
      connected: true,
      host: this.host,
      port: this.port,
      profileDir: this.profileDir,
    }
  }

  private async waitForConnection(
    options: Required<RpaConnectBrowserOptions>,
    timeoutMs: number,
  ): Promise<RpaBrowserConnection> {
    const startedAt = Date.now()
    let lastError: string | undefined

    this.host = options.host
    this.port = options.port

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const version = await this.fetchJson<Record<string, unknown>>('/json/version')
        return {
          connected: true,
          host: options.host,
          port: options.port,
          browser: typeof version.Browser === 'string' ? version.Browser : undefined,
          profileDir: this.profileDir,
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await delay(400)
      }
    }

    return {
      connected: false,
      host: options.host,
      port: options.port,
      profileDir: this.profileDir,
      error: lastError || 'Unable to connect to browser debugging port',
    }
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`http://${this.host}:${this.port}${path}`, init)
    if (!response.ok) {
      throw new Error(`Chrome DevTools endpoint failed: HTTP ${response.status}`)
    }
    return await response.json() as T
  }

  private async findTargetForUrl(url: string): Promise<RpaTarget | undefined> {
    const desired = new URL(url)
    const desiredRoot = getRegistrableRoot(desired.hostname)
    const targets = await this.listTargets().catch(() => [])

    return targets
      .filter((target) => target.webSocketDebuggerUrl)
      .map((target) => ({
        target,
        score: scoreTarget(target, desired, desiredRoot),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.target
  }

  private async waitForNavigableTarget(targetId: string, url: string, timeoutMs: number): Promise<RpaTarget> {
    const startedAt = Date.now()
    const desired = new URL(url)
    const desiredRoot = getRegistrableRoot(desired.hostname)

    while (Date.now() - startedAt < timeoutMs) {
      const target = await this.getTarget(targetId)
      if (target && scoreTarget(target, desired, desiredRoot) > 0 && target.webSocketDebuggerUrl) {
        return target
      }
      await delay(400)
    }

    const target = await this.getTarget(targetId)
    if (!target) {
      throw new Error('Opened browser tab disappeared before it became available')
    }
    return target
  }
}

function normalizeTargetUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) {
    throw new Error('Provider URL is required for automatic RPA learning')
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `https://${trimmed}`
}

function scoreTarget(target: RpaTarget, desired: URL, desiredRoot: string): number {
  if (!target.url || target.url === 'about:blank') {
    return 0
  }

  try {
    const targetUrl = new URL(target.url)
    const targetRoot = getRegistrableRoot(targetUrl.hostname)
    let score = 0

    if (targetUrl.origin === desired.origin) score += 100
    if (targetUrl.hostname === desired.hostname) score += 80
    if (targetRoot && targetRoot === desiredRoot) score += 45
    if (targetUrl.pathname === desired.pathname) score += 15
    if (target.title.toLowerCase().includes(desired.hostname.replace(/^www\./, '').split('.')[0])) score += 10

    return score
  } catch {
    return 0
  }
}

function getRegistrableRoot(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean)
  if (parts.length <= 2) {
    return hostname
  }

  return parts.slice(-2).join('.')
}

function resolveBrowserExecutable(browser: RpaBrowser): string | null {
  const candidates = browser === 'edge' ? getEdgeCandidates() : getChromeCandidates()
  return candidates.find((candidate) => candidate.executable || existsSync(candidate.path))?.path || null
}

function getChromeCandidates(): Array<{ path: string; executable?: boolean }> {
  if (process.platform === 'darwin') {
    return [
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { path: join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
    ]
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return [
      { path: join(programFiles, 'Google/Chrome/Application/chrome.exe') },
      { path: join(programFilesX86, 'Google/Chrome/Application/chrome.exe') },
      { path: join(localAppData, 'Google/Chrome/Application/chrome.exe') },
    ]
  }

  return [
    { path: 'google-chrome', executable: true },
    { path: 'google-chrome-stable', executable: true },
    { path: 'chromium', executable: true },
    { path: 'chromium-browser', executable: true },
  ]
}

function getEdgeCandidates(): Array<{ path: string; executable?: boolean }> {
  if (process.platform === 'darwin') {
    return [
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { path: join(homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') },
    ]
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || ''
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return [
      { path: join(programFiles, 'Microsoft/Edge/Application/msedge.exe') },
      { path: join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe') },
      { path: join(localAppData, 'Microsoft/Edge/Application/msedge.exe') },
    ]
  }

  return [
    { path: 'microsoft-edge', executable: true },
    { path: 'microsoft-edge-stable', executable: true },
  ]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
