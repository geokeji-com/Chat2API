import { BrowserWindow } from 'electron'
import type {
  RpaBrowserConnection,
  RpaCapturedRequest,
  RpaConnectBrowserOptions,
  RpaCredentialReference,
  RpaLaunchBrowserOptions,
  RpaLearningResult,
  RpaLearningSessionSummary,
  RpaPatchPreview,
  RpaProgressEvent,
  RpaStartLearningOptions,
  RpaTarget,
} from '../../shared/rpa'
import { IpcChannels } from '../ipc/channels'
import { AccountManager } from '../store/accounts'
import { BrowserBridge } from './browserBridge'
import { NetworkCaptureService } from './networkCaptureService'
import { RequestClassifier } from './requestClassifier'
import { AdapterCodeGenerator } from './adapterCodeGenerator'

interface RpaLearningSession {
  id: string
  status: RpaLearningSessionSummary['status']
  startedAt: number
  target: RpaTarget
  capture: NetworkCaptureService
  timeout?: NodeJS.Timeout
  result?: RpaLearningResult
  patch?: RpaPatchPreview
  warnings: string[]
  credentialsReference?: RpaCredentialReference
}

const DEFAULT_TIMEOUT_MS = 120000

export class RpaLearningManager {
  private readonly browserBridge = new BrowserBridge()
  private readonly classifier = new RequestClassifier()
  private readonly codeGenerator = new AdapterCodeGenerator()
  private readonly sessions = new Map<string, RpaLearningSession>()
  private mainWindow: BrowserWindow | null = null
  private activeSessionId: string | null = null

  setMainWindow(mainWindow: BrowserWindow | null): void {
    this.mainWindow = mainWindow
  }

  async launchBrowser(options: RpaLaunchBrowserOptions): Promise<RpaBrowserConnection> {
    this.sendProgress({ status: 'launching', message: 'Launching controlled browser...' })
    const result = await this.browserBridge.launchBrowser(options)
    this.sendProgress({
      status: result.connected ? 'connected' : 'error',
      message: result.connected ? 'Browser debugging port is ready' : result.error || 'Browser launch failed',
      data: { port: result.port, browser: result.browser },
    })
    return result
  }

  async connectBrowser(options: RpaConnectBrowserOptions): Promise<RpaBrowserConnection> {
    const result = await this.browserBridge.connectBrowser(options)
    this.sendProgress({
      status: result.connected ? 'connected' : 'error',
      message: result.connected ? 'Connected to browser debugging port' : result.error || 'Browser connection failed',
      data: { port: result.port, browser: result.browser },
    })
    return result
  }

  async listTargets(): Promise<RpaTarget[]> {
    return this.browserBridge.listTargets()
  }

  async startLearning(options: RpaStartLearningOptions): Promise<RpaLearningSessionSummary> {
    if (this.activeSessionId) {
      await this.finishSession(this.activeSessionId, 'cancelled')
    }

    const target = await this.browserBridge.getTarget(options.targetId)
    if (!target) {
      throw new Error('Selected browser tab was not found')
    }

    const capture = new NetworkCaptureService(target)
    const sessionId = generateId()
    const session: RpaLearningSession = {
      id: sessionId,
      status: 'capturing',
      startedAt: Date.now(),
      target,
      capture,
      warnings: [],
      credentialsReference: this.getCredentialReference(options.providerId, options.accountId),
    }

    this.sessions.set(sessionId, session)
    this.activeSessionId = sessionId

    capture.on('captured', (request: RpaCapturedRequest) => {
      this.sendToRenderer(IpcChannels.RPA_REQUEST_CAPTURED, {
        sessionId,
        request,
      })
    })

    try {
      await capture.start()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      session.status = 'error'
      session.warnings.push(message)
      this.activeSessionId = null
      await capture.stop().catch(() => [])
      this.sendProgress({
        status: 'error',
        sessionId,
        message: `Failed to start browser capture: ${message}`,
      })
      throw error
    }

    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
    session.timeout = setTimeout(() => {
      void this.finishSession(sessionId, 'timeout')
    }, timeoutMs)

    this.sendProgress({
      status: 'capturing',
      sessionId,
      message: 'Listening to the selected tab. Send one normal question in the browser.',
      data: { timeoutMs, targetUrl: target.url },
    })

    return this.toSummary(session)
  }

  async cancelLearning(): Promise<boolean> {
    if (!this.activeSessionId) {
      return false
    }

    await this.finishSession(this.activeSessionId, 'cancelled')
    return true
  }

  getSession(sessionId: string): RpaLearningSessionSummary | undefined {
    const session = this.sessions.get(sessionId)
    return session ? this.toSummary(session) : undefined
  }

  async generatePatch(sessionId: string): Promise<RpaPatchPreview> {
    const session = this.getRequiredSession(sessionId)
    const result = this.ensureResult(session)
    const patch = this.codeGenerator.generate(result)

    session.patch = patch
    session.status = 'patch-ready'

    this.sendProgress({
      status: 'patch-ready',
      sessionId,
      message: patch.canApply ? 'Patch preview generated' : 'Patch preview generated with warnings',
      data: { confidence: patch.confidence, files: patch.files.length },
    })

    return patch
  }

  async applyPatch(sessionId: string): Promise<RpaPatchPreview> {
    const session = this.getRequiredSession(sessionId)
    const patch = session.patch || await this.generatePatch(sessionId)

    this.codeGenerator.apply(patch, process.cwd())
    session.status = 'applied'

    this.sendProgress({
      status: 'applied',
      sessionId,
      message: 'Generated source artifacts were written to the checkout',
      data: { files: patch.files.map((file) => file.path) },
    })

    return patch
  }

  private async finishSession(sessionId: string, status: 'timeout' | 'cancelled' | 'classified'): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (session.timeout) {
      clearTimeout(session.timeout)
      session.timeout = undefined
    }

    await session.capture.stop().catch((error) => {
      session.warnings.push(error instanceof Error ? error.message : String(error))
      return []
    })

    session.status = status
    this.ensureResult(session)

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }

    this.sendProgress({
      status,
      sessionId,
      message: status === 'timeout' ? 'Learning session timed out and was classified' : 'Learning session stopped',
      data: { capturedCount: session.capture.getCaptured().length },
    })
  }

  private ensureResult(session: RpaLearningSession): RpaLearningResult {
    if (session.result) {
      return session.result
    }

    session.result = this.classifier.classify({
      sessionId: session.id,
      target: session.target,
      requests: session.capture.getCaptured(),
      credentialsReference: session.credentialsReference,
    })
    session.warnings = Array.from(new Set([...session.warnings, ...session.result.warnings]))

    return session.result
  }

  private getCredentialReference(providerId?: string, accountId?: string): RpaCredentialReference | undefined {
    if (!accountId && !providerId) {
      return undefined
    }

    const account = accountId ? AccountManager.getById(accountId, true) : undefined
    return {
      providerId: providerId || account?.providerId,
      accountId,
      credentialKeys: Object.keys(account?.credentials || {}),
    }
  }

  private getRequiredSession(sessionId: string): RpaLearningSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`RPA learning session not found: ${sessionId}`)
    }
    return session
  }

  private toSummary(session: RpaLearningSession): RpaLearningSessionSummary {
    return {
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      target: session.target,
      capturedCount: session.capture.getCaptured().length,
      result: session.result,
      patch: session.patch,
      warnings: session.warnings,
    }
  }

  private sendProgress(event: RpaProgressEvent): void {
    this.sendToRenderer(IpcChannels.RPA_PROGRESS, event)
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export const rpaLearningManager = new RpaLearningManager()
