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

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`http://${this.host}:${this.port}${path}`)
    if (!response.ok) {
      throw new Error(`Chrome DevTools endpoint failed: HTTP ${response.status}`)
    }
    return await response.json() as T
  }
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
