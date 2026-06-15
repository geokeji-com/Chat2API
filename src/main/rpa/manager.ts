import { BrowserWindow } from 'electron'
import {
  getRpaLearningTargetById,
  getRpaLearningTargetForProvider,
  type RpaBrowserConnection,
  type RpaCapturedRequest,
  type RpaConnectBrowserOptions,
  type RpaCredentialReference,
  type RpaLaunchBrowserOptions,
  type RpaAutoLearnProviderOptions,
  type RpaAnalysisReport,
  type RpaLearningResult,
  type RpaLearningSessionSummary,
  type RpaPatchPreview,
  type RpaProviderLearningTarget,
  type RpaProviderLearningTargetId,
  type RpaProgressEvent,
  type RpaStartRecordingOptions,
  type RpaStartAutoLearningOptions,
  type RpaStartLearningOptions,
  type RpaTarget,
  type RpaAutomationStepResult,
  type RpaAutoScenarioStep,
} from '../../shared/rpa'
import { IpcChannels } from '../ipc/channels'
import { getBuiltinProvider } from '../providers/builtin'
import { getTokenExtractionConfig } from '../oauth/tokenExtractionConfig'
import type { ProviderType as OAuthProviderType } from '../oauth/types'
import { AccountManager } from '../store/accounts'
import { BrowserBridge } from './browserBridge'
import { NetworkCaptureService } from './networkCaptureService'
import { RequestClassifier } from './requestClassifier'
import { AdapterCodeGenerator } from './adapterCodeGenerator'
import { AnalysisReportGenerator } from './analysisReportGenerator'
import { RpaScenarioRunner } from './scenarioRunner'

interface RpaLearningSession {
  id: string
  status: RpaLearningSessionSummary['status']
  startedAt: number
  target: RpaTarget
  learningTarget?: RpaProviderLearningTarget
  capture: NetworkCaptureService
  timeout?: NodeJS.Timeout
  result?: RpaLearningResult
  patch?: RpaPatchPreview
  report?: RpaAnalysisReport
  warnings: string[]
  credentialsReference?: RpaCredentialReference
  automationSteps?: RpaAutomationStepResult[]
}

const DEFAULT_TIMEOUT_MS = 120000

export class RpaLearningManager {
  private readonly browserBridge = new BrowserBridge()
  private readonly classifier = new RequestClassifier()
  private readonly codeGenerator = new AdapterCodeGenerator()
  private readonly reportGenerator = new AnalysisReportGenerator()
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
    const providerId = this.resolveProviderId(options)
    const learningTarget = this.resolveLearningTarget({ ...options, providerId })

    const capture = new NetworkCaptureService(target, {
      captureDomains: learningTarget?.captureDomains,
    })
    const sessionId = generateId()
    const session: RpaLearningSession = {
      id: sessionId,
      status: 'capturing',
      startedAt: Date.now(),
      target,
      learningTarget,
      capture,
      warnings: [],
      credentialsReference: this.getCredentialReference(providerId, options.accountId),
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

  async startRecording(options: RpaStartRecordingOptions): Promise<RpaLearningSessionSummary> {
    if (this.activeSessionId) {
      await this.finishSession(this.activeSessionId, 'classified')
    }

    const providerId = this.resolveProviderId(options)
    const learningTarget = this.resolveLearningTarget({ ...options, providerId })
    const providerUrl = this.resolveProviderUrl({ ...options, providerId, learningTargetId: learningTarget?.id })

    this.sendProgress({
      status: 'launching',
      message: 'Preparing browser request recording...',
      data: { providerUrl },
    })

    const resolved = await this.browserBridge.resolveOrOpenTarget({
      url: providerUrl,
      browser: options.browser,
      port: options.port,
    })

    const session = await this.createCaptureSession(resolved.target, {
      learningTarget,
      providerId,
      accountId: options.accountId,
      timeoutMs: options.timeoutMs || 300000,
      message: 'Recording started. Operate the browser manually, then stop recording to analyze requests.',
    })

    this.sendProgress({
      status: 'capturing',
      sessionId: session.id,
      message: resolved.opened ? 'Provider page opened. Please complete the workflow manually.' : 'Matched provider tab. Please complete the workflow manually.',
      data: { targetUrl: resolved.target.url, port: resolved.connection.port },
    })

    return this.toSummary(session)
  }

  async startAutoLearning(options: RpaStartAutoLearningOptions): Promise<RpaLearningSessionSummary> {
    if (this.activeSessionId) {
      await this.finishSession(this.activeSessionId, 'cancelled')
    }

    const target = await this.browserBridge.getTarget(options.targetId)
    if (!target) {
      throw new Error('Selected browser tab was not found')
    }

    return await this.runAutomaticLearning(target, options)
  }

  async autoLearnProvider(options: RpaAutoLearnProviderOptions): Promise<RpaLearningSessionSummary> {
    if (this.activeSessionId) {
      await this.finishSession(this.activeSessionId, 'cancelled')
    }

    const providerId = this.resolveProviderId(options)
    const learningTarget = this.resolveLearningTarget({ ...options, providerId })
    const providerUrl = this.resolveProviderUrl({ ...options, providerId, learningTargetId: learningTarget?.id })

    const discoverStep = createAutomationStep(
      'discover-browser',
      true,
      'Discovering browser debugging endpoint',
    )
    this.sendProgress({
      status: 'launching',
      message: 'Discovering a Chrome or Edge DevTools browser...',
      data: { step: discoverStep },
    })

    const resolved = await this.browserBridge.resolveOrOpenTarget({
      url: providerUrl,
      browser: options.browser,
      port: options.port,
    })

    const connectedStep = createAutomationStep(
      'discover-browser',
      true,
      `Browser connected on port ${resolved.connection.port}`,
      resolved.connection.browser,
      100,
    )
    this.sendProgress({
      status: 'connected',
      message: resolved.connection.browser
        ? `${resolved.connection.browser} connected on port ${resolved.connection.port}`
        : `Browser connected on port ${resolved.connection.port}`,
      data: { step: connectedStep },
    })

    const openTargetStep = createAutomationStep(
      'open-target',
      true,
      resolved.opened ? 'Opened provider page' : 'Matched existing provider tab',
      resolved.target.url,
      100,
    )
    this.sendProgress({
      status: 'connected',
      message: resolved.opened ? 'Opened provider page for automatic learning' : 'Matched existing provider tab',
      data: { step: openTargetStep },
    })

    return await this.runAutomaticLearning(resolved.target, {
      targetId: resolved.target.id,
      learningTargetId: learningTarget?.id,
      providerId,
      accountId: options.accountId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs || 180000,
      answerTimeoutMs: options.answerTimeoutMs,
      shareTimeoutMs: options.shareTimeoutMs,
      loginTimeoutMs: options.loginTimeoutMs,
      share: options.share !== false,
    }, [connectedStep, openTargetStep])
  }

  private async runAutomaticLearning(
    target: RpaTarget,
    options: RpaStartAutoLearningOptions,
    initialSteps: RpaAutomationStepResult[] = [],
  ): Promise<RpaLearningSessionSummary> {
    const providerId = this.resolveProviderId(options)
    const learningTarget = this.resolveLearningTarget({ ...options, providerId })
    const capture = new NetworkCaptureService(target, {
      captureDomains: learningTarget?.captureDomains,
    })
    const sessionId = generateId()
    const session: RpaLearningSession = {
      id: sessionId,
      status: 'capturing',
      startedAt: Date.now(),
      target,
      learningTarget,
      capture,
      warnings: [],
      automationSteps: initialSteps,
      credentialsReference: this.getCredentialReference(providerId, options.accountId),
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
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
      session.timeout = setTimeout(() => {
        void this.finishSession(sessionId, 'timeout')
      }, timeoutMs)

      this.sendProgress({
        status: 'capturing',
        sessionId,
        message: 'Automatic learning started. The selected tab will be operated through Chrome DevTools.',
        data: { timeoutMs, targetUrl: target.url },
      })

      const runner = new RpaScenarioRunner({
        target,
        prompt: options.prompt || '',
        options,
        getCaptured: () => capture.getCaptured(),
        onStep: (step) => {
          session.automationSteps = [...(session.automationSteps || []), step]
          this.sendProgress({
            status: 'capturing',
            sessionId,
            message: step.message,
            data: { step },
          })
        },
      })

      session.automationSteps = await runner.run()
      await this.finishSession(sessionId, 'classified')
      return this.toSummary(session)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      session.status = 'error'
      session.warnings.push(message)
      session.result = this.classifier.classify({
        sessionId: session.id,
        target: session.target,
        learningTarget: session.learningTarget,
        requests: session.capture.getCaptured(),
        credentialsReference: session.credentialsReference,
      })
      session.result.automationSteps = session.automationSteps
      if (session.timeout) {
        clearTimeout(session.timeout)
        session.timeout = undefined
      }
      this.activeSessionId = null
      await capture.stop().catch(() => [])
      this.sendProgress({
        status: 'error',
        sessionId,
        message,
      })
      throw error
    }
  }

  private async createCaptureSession(
    target: RpaTarget,
    options: {
      learningTarget?: RpaProviderLearningTarget
      providerId?: string
      accountId?: string
      timeoutMs: number
      message: string
    },
  ): Promise<RpaLearningSession> {
    const capture = new NetworkCaptureService(target, {
      captureDomains: options.learningTarget?.captureDomains,
    })
    const sessionId = generateId()
    const session: RpaLearningSession = {
      id: sessionId,
      status: 'capturing',
      startedAt: Date.now(),
      target,
      learningTarget: options.learningTarget,
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

    session.timeout = setTimeout(() => {
      void this.finishSession(sessionId, 'timeout')
    }, options.timeoutMs)

    this.sendProgress({
      status: 'capturing',
      sessionId,
      message: options.message,
      data: { timeoutMs: options.timeoutMs, targetUrl: target.url },
    })

    return session
  }

  async cancelLearning(): Promise<boolean> {
    if (!this.activeSessionId) {
      return false
    }

    await this.finishSession(this.activeSessionId, 'cancelled')
    return true
  }

  async stopLearning(): Promise<RpaLearningSessionSummary | undefined> {
    if (!this.activeSessionId) {
      return undefined
    }

    const sessionId = this.activeSessionId
    await this.finishSession(sessionId, 'classified')
    return this.getSession(sessionId)
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

  async generateReport(sessionId: string): Promise<RpaAnalysisReport> {
    const session = this.getRequiredSession(sessionId)
    const result = this.ensureResult(session)
    const report = this.reportGenerator.generate(result)

    session.report = report

    this.sendProgress({
      status: session.status,
      sessionId,
      message: 'Analysis report generated',
      data: { chars: report.markdown.length },
    })

    return report
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
      learningTarget: session.learningTarget,
      requests: session.capture.getCaptured(),
      credentialsReference: session.credentialsReference,
    })
    session.result.automationSteps = session.automationSteps
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

  private resolveProviderId(options: ProviderResolutionOptions): string | undefined {
    if (options.providerId) {
      return options.providerId
    }

    if (options.accountId) {
      return AccountManager.getById(options.accountId)?.providerId
    }

    return undefined
  }

  private resolveProviderUrl(options: ProviderResolutionOptions): string {
    if (options.providerUrl) {
      return normalizeProviderUrl(options.providerUrl)
    }

    const learningTarget = this.resolveLearningTarget(options)
    if (learningTarget?.url) {
      return learningTarget.url
    }

    const providerId = options.providerId
    if (providerId && isOAuthProviderType(providerId)) {
      const extractionConfig = getTokenExtractionConfig(providerId)
      if (extractionConfig?.loginUrl) {
        return extractionConfig.loginUrl
      }
    }

    if (providerId) {
      const provider = getBuiltinProvider(providerId)
      if (provider?.apiEndpoint) {
        return deriveWebUrl(provider.apiEndpoint)
      }
    }

    throw new Error('Choose a provider or enter a provider URL before starting automatic learning')
  }

  private resolveLearningTarget(options: ProviderResolutionOptions): RpaProviderLearningTarget | undefined {
    const explicitTarget = getRpaLearningTargetById(options.learningTargetId)
    if (explicitTarget) {
      return explicitTarget
    }

    const providerId = this.resolveProviderId(options)
    return getRpaLearningTargetForProvider(providerId)
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
      report: session.report,
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

interface ProviderResolutionOptions {
  learningTargetId?: RpaProviderLearningTargetId
  providerId?: string
  accountId?: string
  providerUrl?: string
}

function createAutomationStep(
  step: RpaAutoScenarioStep,
  success: boolean,
  message: string,
  targetLabel?: string,
  confidence?: number,
): RpaAutomationStepResult {
  return {
    step,
    success,
    message,
    targetLabel,
    confidence,
  }
}

function normalizeProviderUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Provider URL cannot be empty')
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function deriveWebUrl(apiEndpoint: string): string {
  const url = new URL(normalizeProviderUrl(apiEndpoint))
  url.pathname = url.pathname
    .replace(/\/api(?:\/.*)?$/i, '')
    .replace(/\/v\d+(?:\/.*)?$/i, '')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function isOAuthProviderType(providerId: string): providerId is OAuthProviderType {
  return [
    'deepseek',
    'doubao',
    'yuanbao',
    'glm',
    'kimi',
    'mimo',
    'minimax',
    'qwen',
    'qwen-ai',
    'zai',
    'perplexity',
  ].includes(providerId)
}

export const rpaLearningManager = new RpaLearningManager()
