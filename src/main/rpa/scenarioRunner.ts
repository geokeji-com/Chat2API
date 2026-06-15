import type {
  RpaAutomationStepResult,
  RpaCapturedRequest,
  RpaStartAutoLearningOptions,
  RpaTarget,
} from '../../shared/rpa'
import { ChromeCdpClient } from './cdpClient'

type Intent = 'input' | 'send' | 'share'

interface VisualCandidate {
  x: number
  y: number
  width?: number
  height?: number
  role: string
  label: string
  confidence: number
  source: 'accessibility' | 'visible-controls' | 'geometry'
}

interface RunnerOptions {
  target: RpaTarget
  prompt: string
  options: RpaStartAutoLearningOptions
  getCaptured: () => RpaCapturedRequest[]
  onStep?: (step: RpaAutomationStepResult) => void
}

const DEFAULT_PROMPT = '请用三句话介绍一下你自己，并在回答后保留当前对话用于分享。'
const DEFAULT_ANSWER_TIMEOUT_MS = 120000
const DEFAULT_SHARE_TIMEOUT_MS = 45000
const DEFAULT_LOGIN_TIMEOUT_MS = 180000

export class RpaScenarioRunner {
  private cdp: ChromeCdpClient | null = null
  private readonly steps: RpaAutomationStepResult[] = []

  constructor(private readonly runnerOptions: RunnerOptions) {}

  async run(): Promise<RpaAutomationStepResult[]> {
    if (!this.runnerOptions.target.webSocketDebuggerUrl) {
      throw new Error('Selected browser tab does not expose a DevTools WebSocket URL')
    }

    this.cdp = await ChromeCdpClient.connect(this.runnerOptions.target.webSocketDebuggerUrl)
    try {
      await this.cdp.send('Page.enable').catch(() => undefined)
      await this.cdp.send('DOM.enable').catch(() => undefined)
      await this.cdp.send('Runtime.enable').catch(() => undefined)
      await this.cdp.send('Accessibility.enable').catch(() => undefined)
      await this.cdp.send('Page.bringToFront').catch(() => undefined)

      await this.captureScreenshotMarker('before-auto-learning')
      const input = await this.waitForPromptInput()
      this.record({
        step: 'wait-login',
        success: Boolean(input),
        message: input ? 'Prompt input is available' : 'Timed out waiting for a logged-in chat page',
        targetLabel: input?.label,
        confidence: input?.confidence,
      })
      if (!input) {
        throw new Error('Could not find a prompt input. Please finish login or verification in the browser and retry.')
      }

      await this.clickCandidate(input)
      this.record({
        step: 'focus-input',
        success: true,
        message: 'Focused the prompt input by semantic page analysis',
        targetLabel: describeCandidate(input),
        confidence: input.confidence,
      })

      await this.typePrompt(this.runnerOptions.prompt || DEFAULT_PROMPT, input)

      const answerStartedAt = Date.now()
      const submit = await this.submitPrompt(input, answerStartedAt)
      this.record({
        step: 'send-prompt',
        success: submit.success,
        message: submit.message,
        targetLabel: submit.target?.label,
        confidence: submit.target?.confidence,
      })
      if (!submit.success) {
        throw new Error(submit.message)
      }

      const chatRequest = submit.chatRequest || await waitForObservedRequest({
        getCaptured: this.runnerOptions.getCaptured,
        since: answerStartedAt - 1500,
        timeoutMs: this.runnerOptions.options.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS,
        predicate: isLikelyChatCompletion,
      })
      const answerReady = chatRequest
        ? await this.waitForAnswerReady(chatRequest, answerStartedAt)
        : undefined
      this.record({
        step: 'wait-answer',
        success: Boolean(answerReady),
        message: answerReady
          ? `Observed answer readiness: ${new URL(answerReady.url).pathname}`
          : 'Timed out waiting for the answer to finish',
        targetLabel: answerReady?.url || chatRequest?.url,
        confidence: answerReady ? 100 : 0,
      })
      if (!answerReady) {
        throw new Error('Timed out waiting for the answer generation request to finish')
      }

      await delay(1200)
      await this.captureScreenshotMarker('after-answer')

      if (this.runnerOptions.options.share === false) {
        return [...this.steps]
      }

      const shareClickedAt = Date.now()
      const shareResult = await this.triggerShareFlow(shareClickedAt)
      this.record({
        step: 'click-share',
        success: Boolean(shareResult.target),
        message: shareResult.target ? 'Clicked the share control' : 'Could not find a share control',
        targetLabel: shareResult.target ? describeCandidate(shareResult.target) : undefined,
        confidence: shareResult.target?.confidence,
      })
      if (!shareResult.target) {
        throw new Error('Could not find a share control after the answer completed')
      }

      const shareRequest = shareResult.request
      this.record({
        step: 'wait-share-request',
        success: Boolean(shareRequest),
        message: shareRequest
          ? `Observed share request: ${new URL(shareRequest.url).pathname}`
          : 'Timed out waiting for a share request',
        targetLabel: shareRequest?.url,
        confidence: shareRequest ? 100 : 0,
      })
      if (!shareRequest) {
        throw new Error('Timed out waiting for the share request')
      }

      await this.captureScreenshotMarker('after-share')
      return [...this.steps]
    } finally {
      this.cdp?.close()
      this.cdp = null
    }
  }

  private async submitPrompt(input: VisualCandidate, since: number): Promise<{
    success: boolean
    message: string
    target?: VisualCandidate
    chatRequest?: RpaCapturedRequest
  }> {
    const candidateAttempts = [
      ...await this.resolveIntentCandidates('send', input, 5),
      ...await this.getGeometricSendCandidates(input),
      ...this.getFallbackSendHotspots(input),
    ]

    for (const target of dedupeCandidates(candidateAttempts).slice(0, 10)) {
      await this.clickCandidate(target)
      const chatRequest = await waitForObservedRequest({
        getCaptured: this.runnerOptions.getCaptured,
        since: since - 1500,
        timeoutMs: 3500,
        predicate: isLikelyChatCompletion,
      })
      if (chatRequest) {
        return {
          success: true,
          message: `Clicked ${describeCandidate(target)}; observed chat request ${new URL(chatRequest.url).pathname}`,
          target,
          chatRequest,
        }
      }
    }

    const keyboardAttempts: Array<{
      label: string
      modifiers?: Array<'Meta' | 'Control'>
      confidence: number
    }> = [
      { label: 'Enter', confidence: 40 },
      { label: 'Command+Enter', modifiers: ['Meta'], confidence: 35 },
      { label: 'Control+Enter', modifiers: ['Control'], confidence: 35 },
    ]

    for (const attempt of keyboardAttempts) {
      await this.pressKeyChord('Enter', attempt.modifiers || [])
      const target: VisualCandidate = {
        x: input.x,
        y: input.y,
        role: 'keyboard',
        label: attempt.label,
        confidence: attempt.confidence,
        source: 'geometry',
      }
      const chatRequest = await waitForObservedRequest({
        getCaptured: this.runnerOptions.getCaptured,
        since: since - 1500,
        timeoutMs: 3500,
        predicate: isLikelyChatCompletion,
      })
      if (chatRequest) {
        return {
          success: true,
          message: `Submitted with ${attempt.label}; observed chat request ${new URL(chatRequest.url).pathname}`,
          target,
          chatRequest,
        }
      }
    }

    return {
      success: false,
      message: 'Prompt text was entered, but no chat request was observed after clicking send and trying keyboard submit shortcuts.',
    }
  }

  private async waitForPromptInput(): Promise<VisualCandidate | undefined> {
    const timeoutMs = this.runnerOptions.options.loginTimeoutMs || DEFAULT_LOGIN_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const input = await this.resolveIntent('input')
      if (input) {
        return input
      }
      await delay(1000)
    }

    return undefined
  }

  private async waitForAnswerReady(
    chatRequest: RpaCapturedRequest,
    since: number,
  ): Promise<RpaCapturedRequest | undefined> {
    const deadline = Date.now() + (this.runnerOptions.options.answerTimeoutMs || DEFAULT_ANSWER_TIMEOUT_MS)
    const chatRequestBaseId = baseRequestId(chatRequest.id)

    while (Date.now() < deadline) {
      const completed = this.runnerOptions.getCaptured()
        .filter((request) => request.startedAt >= since - 1500)
        .find((request) => {
          const sameRequest = baseRequestId(request.id) === chatRequestBaseId
          return sameRequest && request.lifecycle === 'completed' && isLikelyChatCompletion(request)
        })
      if (completed) {
        return completed
      }

      const waitedMs = Date.now() - since
      if (waitedMs > 15000 && !await this.hasGenerationControl()) {
        return chatRequest
      }

      await delay(750)
    }

    return undefined
  }

  private async triggerShareFlow(since: number): Promise<{
    target?: VisualCandidate
    request?: RpaCapturedRequest
  }> {
    const deadline = Date.now() + (this.runnerOptions.options.shareTimeoutMs || DEFAULT_SHARE_TIMEOUT_MS)
    let lastTarget: VisualCandidate | undefined

    while (Date.now() < deadline) {
      const candidates = await this.resolveIntentCandidates('share', undefined, 6)
      for (const target of candidates) {
        lastTarget = target
        await this.clickCandidate(target)
        const request = await waitForObservedRequest({
          getCaptured: this.runnerOptions.getCaptured,
          since: since - 1000,
          timeoutMs: 2500,
          predicate: isLikelyShareRequest,
        })
        if (request) {
          return { target, request }
        }
      }

      const request = await waitForObservedRequest({
        getCaptured: this.runnerOptions.getCaptured,
        since: since - 1000,
        timeoutMs: 800,
        predicate: isLikelyShareRequest,
      })
      if (request) {
        return { target: lastTarget, request }
      }

      await delay(500)
    }

    return { target: lastTarget }
  }

  private async hasGenerationControl(): Promise<boolean> {
    const controls = await this.getVisibleControls()
    return controls.some((control) => /(停止|stop|cancel|取消|generating|生成中)/i.test(`${control.role} ${control.label}`))
  }

  private async clickCandidate(candidate: VisualCandidate): Promise<void> {
    if (!this.cdp) return
    const candidates = [
      candidate,
    ]
    for (const target of candidates) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: target.x,
        y: target.y,
      })
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1,
      })
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1,
      })
    }
    await delay(250)
  }

  private async resolveIntent(intent: Intent, context?: VisualCandidate): Promise<VisualCandidate | undefined> {
    return (await this.resolveIntentCandidates(intent, context, 1))[0]
  }

  private async resolveIntentCandidates(
    intent: Intent,
    context?: VisualCandidate,
    limit = 5,
  ): Promise<VisualCandidate[]> {
    const candidates = [
      ...await this.getAccessibilityCandidates(intent),
      ...await this.getVisibleControlCandidates(intent),
      ...(intent === 'send' && context ? await this.getGeometricSendCandidates(context) : []),
    ].filter((candidate) => Number.isFinite(candidate.x) && Number.isFinite(candidate.y))

    return dedupeCandidates(candidates)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit)
  }

  private async getAccessibilityCandidates(intent: Intent): Promise<VisualCandidate[]> {
    if (!this.cdp) return []

    const result = await this.cdp.send<{ nodes?: any[] }>('Accessibility.getFullAXTree').catch(() => undefined)
    const nodes = result?.nodes || []
    const candidates: VisualCandidate[] = []

    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue

      const role = axValue(node.role).toLowerCase()
      const label = [
        axValue(node.name),
        axValue(node.value),
        axValue(node.description),
        axPropertiesText(node.properties),
      ].filter(Boolean).join(' ').trim()

      const confidence = scoreCandidate(intent, role, label)
      if (confidence <= 0) continue

      const center = await this.getBackendNodeCenter(node.backendDOMNodeId).catch(() => undefined)
      if (!center) continue

      candidates.push({
        ...center,
        role,
        label: label || role,
        confidence,
        source: 'accessibility',
      })
    }

    return candidates
  }

  private async getVisibleControlCandidates(intent: Intent): Promise<VisualCandidate[]> {
    return (await this.getVisibleControls())
      .map((candidate) => ({
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        role: candidate.role,
        label: candidate.label || candidate.role,
        confidence: Math.max(0, scoreCandidate(intent, candidate.role, candidate.label) - 5),
        source: 'visible-controls' as const,
      }))
      .filter((candidate) => candidate.confidence > 0)
  }

  private async getGeometricSendCandidates(input: VisualCandidate): Promise<VisualCandidate[]> {
    const controls = await this.getVisibleControls()
    const inputRight = input.width ? input.x + input.width / 2 : input.x + 260
    const inputBottom = input.height ? input.y + input.height / 2 : input.y + 80
    const inputTop = input.height ? input.y - input.height / 2 : input.y - 80

    return controls
      .filter((control) => isButtonLike(control.role))
      .map((control) => {
        const horizontalDistance = Math.abs(control.x - inputRight)
        const verticalInside = control.y >= inputTop - 20 && control.y <= inputBottom + 36
        const rightOfInputCenter = control.x >= input.x
        const compact = (control.width || 999) <= 96 && (control.height || 999) <= 96
        const labelPenalty = /(分享|share|复制|copy|stop|停止|cancel|取消|设置|setting|上传|upload|附件|attach)/i.test(control.label)
          ? 80
          : 0
        let confidence = 0
        if (verticalInside) confidence += 30
        if (rightOfInputCenter) confidence += 25
        if (horizontalDistance <= 180) confidence += 25
        if (compact) confidence += 20
        confidence -= labelPenalty

        return {
          ...control,
          label: control.label || 'unlabelled button near prompt input',
          confidence,
          source: 'geometry' as const,
        }
      })
      .filter((candidate) => candidate.confidence >= 55)
  }

  private getFallbackSendHotspots(input: VisualCandidate): VisualCandidate[] {
    const inputRight = input.width ? input.x + input.width / 2 : input.x + 260
    const inputBottom = input.height ? input.y + input.height / 2 : input.y + 80
    return [
      {
        x: inputRight - 32,
        y: inputBottom - 32,
        width: 32,
        height: 32,
        role: 'coordinate',
        label: 'bottom-right prompt control hotspot',
        confidence: 52,
        source: 'geometry',
      },
      {
        x: inputRight - 56,
        y: input.y,
        width: 32,
        height: 32,
        role: 'coordinate',
        label: 'right-side prompt control hotspot',
        confidence: 48,
        source: 'geometry',
      },
    ].filter((candidate) => candidate.x > 0 && candidate.y > 0)
  }

  private async getVisibleControls(): Promise<Array<Omit<VisualCandidate, 'confidence' | 'source'> & { disabled?: boolean }>> {
    if (!this.cdp) return []

    const result = await this.cdp.send<{ result?: { value?: Array<Omit<VisualCandidate, 'confidence' | 'source'> & { disabled?: boolean }> } }>(
      'Runtime.evaluate',
      {
        returnByValue: true,
        expression: `(() => {
          const isVisible = (el) => {
            const style = window.getComputedStyle(el)
            const rect = el.getBoundingClientRect()
            return style.visibility !== 'hidden'
              && style.display !== 'none'
              && rect.width >= 8
              && rect.height >= 8
              && rect.bottom >= 0
              && rect.right >= 0
              && rect.top <= window.innerHeight
              && rect.left <= window.innerWidth
          }
          const labelFor = (el) => {
            const parent = el.parentElement
            return [
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
              el.innerText,
              el.value,
              parent?.getAttribute('aria-label'),
              parent?.getAttribute('title'),
            ].filter(Boolean).join(' ').trim()
          }
          const isNativeInteractive = (el) => {
            const tag = el.tagName.toLowerCase()
            return tag === 'button'
              || tag === 'textarea'
              || tag === 'input'
              || tag === 'select'
              || tag === 'a'
              || el.isContentEditable
              || Boolean(el.getAttribute('role'))
              || Boolean(el.getAttribute('aria-label'))
              || Boolean(el.getAttribute('title'))
          }
          const isProbablyClickable = (el) => {
            const style = window.getComputedStyle(el)
            const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null
            return isNativeInteractive(el)
              || style.cursor === 'pointer'
              || parentStyle?.cursor === 'pointer'
              || typeof el.onclick === 'function'
              || el.tabIndex >= 0
              || Boolean(el.getAttribute('jsaction'))
              || Boolean(el.getAttribute('data-testid'))
              || Boolean(el.getAttribute('data-test-id'))
              || ['svg', 'path'].includes(el.tagName.toLowerCase())
          }
          return Array.from(document.querySelectorAll('*'))
            .filter((el) => isVisible(el) && isProbablyClickable(el))
            .slice(0, 250)
            .map((el) => {
              const rect = el.getBoundingClientRect()
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                width: rect.width,
                height: rect.height,
                role: (el.getAttribute('role') || el.tagName || '').toLowerCase(),
                label: labelFor(el),
                disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
              }
            })
        })()`,
      },
    ).catch(() => undefined)

    return (result?.result?.value || [])
      .filter((candidate) => !candidate.disabled)
  }

  private async getBackendNodeCenter(backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    if (!this.cdp) return undefined
    const result = await this.cdp.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
      backendNodeId,
    })
    const content = result.model?.content
    if (!content || content.length < 8) return undefined

    const xs = [content[0], content[2], content[4], content[6]]
    const ys = [content[1], content[3], content[5], content[7]]
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    }
  }

  private async typePrompt(prompt: string, input: VisualCandidate): Promise<void> {
    if (!this.cdp) return
    await this.cdp.send('Input.insertText', { text: prompt })
    await this.ensurePromptText(prompt, input)
    await delay(600)
  }

  private async ensurePromptText(prompt: string, input: VisualCandidate): Promise<void> {
    if (!this.cdp) return
    const promptJson = JSON.stringify(prompt)
    const xJson = JSON.stringify(input.x)
    const yJson = JSON.stringify(input.y)
    await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const prompt = ${promptJson}
        const point = { x: ${xJson}, y: ${yJson} }
        const active = document.activeElement
        const pointElement = document.elementFromPoint(point.x, point.y)
        const findEditable = (el) => {
          let current = el
          while (current && current !== document.body) {
            const tag = current.tagName ? current.tagName.toLowerCase() : ''
            if (tag === 'textarea' || tag === 'input' || current.isContentEditable) return current
            current = current.parentElement
          }
          return null
        }
        const target = findEditable(active) || findEditable(pointElement)
        if (!target) return false
        const textOf = (el) => 'value' in el ? String(el.value || '') : String(el.innerText || el.textContent || '')
        if (textOf(target).includes(prompt.slice(0, Math.min(prompt.length, 24)))) return true
        target.focus()
        if ('value' in target) {
          target.value = textOf(target) + prompt
        } else {
          target.textContent = textOf(target) + prompt
        }
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`,
      returnByValue: true,
    }).catch(() => undefined)
  }

  private async pressKeyChord(key: 'Enter', modifiers: Array<'Meta' | 'Control'> = []): Promise<void> {
    if (!this.cdp) return
    const modifierValue = modifiers.reduce((value, modifier) => {
      if (modifier === 'Meta') return value + 4
      if (modifier === 'Control') return value + 2
      return value
    }, 0)
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: modifierValue,
    })
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: modifierValue,
    })
  }

  private async captureScreenshotMarker(label: string): Promise<void> {
    if (!this.cdp) return
    await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 55,
      captureBeyondViewport: false,
    }).then(() => undefined).catch(() => undefined)
    void label
  }

  private record(step: RpaAutomationStepResult): void {
    this.steps.push(step)
    this.runnerOptions.onStep?.(step)
  }
}

function axValue(value: any): string {
  if (!value) return ''
  if (typeof value.value === 'string') return value.value
  if (typeof value.value === 'number' || typeof value.value === 'boolean') return String(value.value)
  return ''
}

function axPropertiesText(properties: any[] | undefined): string {
  if (!Array.isArray(properties)) return ''
  return properties
    .map((property) => `${property.name || ''}:${axValue(property.value)}`)
    .join(' ')
}

function scoreCandidate(intent: Intent, role: string, label: string): number {
  const text = `${role} ${label}`.toLowerCase()
  const normalizedRole = role.toLowerCase()

  if (intent === 'input') {
    let score = 0
    if (/(text|textbox|textfield|searchbox|input|textarea|editable)/i.test(normalizedRole)) score += 65
    if (/(输入|提问|发送消息|问点|问我|message|prompt|ask|chat|textarea|search)/i.test(text)) score += 25
    if (/(password|token|cookie|邮箱|email|登录|login)/i.test(text)) score -= 80
    return score >= 45 ? Math.min(score, 100) : 0
  }

  if (intent === 'send') {
    let score = 0
    if (/(button|link|menuitem)/i.test(normalizedRole)) score += 35
    if (/(发送|提交|开始|send|submit|ask|arrow|enter|生成)/i.test(text)) score += 55
    if (/(分享|share|复制|copy|stop|停止|cancel|取消)/i.test(text)) score -= 70
    return score >= 45 ? Math.min(score, 100) : 0
  }

  let score = 0
  if (/(button|link|menuitem)/i.test(normalizedRole)) score += 35
  if (/(分享|共享|share|复制链接|copy link|public link)/i.test(text)) score += 60
  if (/(发送|send|submit|停止|stop|取消|cancel|重新|retry)/i.test(text)) score -= 60
  return score >= 50 ? Math.min(score, 100) : 0
}

function isButtonLike(role: string): boolean {
  return /(button|link|menuitem|a|div|span|svg|path|coordinate)/i.test(role)
}

async function waitForObservedRequest(options: {
  getCaptured: () => RpaCapturedRequest[]
  since: number
  timeoutMs: number
  predicate: (request: RpaCapturedRequest) => boolean
}): Promise<RpaCapturedRequest | undefined> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    const matched = options.getCaptured()
      .filter((request) => request.startedAt >= options.since)
      .sort((a, b) => requestLifecycleWeight(b) - requestLifecycleWeight(a))
      .find(options.predicate)
    if (matched) {
      return matched
    }
    await delay(500)
  }
  return undefined
}

function requestLifecycleWeight(request: RpaCapturedRequest): number {
  if (request.lifecycle === 'completed') return 4
  if (request.lifecycle === 'response') return 3
  if (request.lifecycle === 'started') return 2
  if (request.lifecycle === 'failed') return 1
  return 0
}

function isLikelyChatCompletion(request: RpaCapturedRequest): boolean {
  if (request.method === 'GET') return false
  const text = `${request.url}\n${request.requestBody || ''}\n${request.responseBody || ''}`.toLowerCase()
  return /chat|conversation|completion|message|ask/.test(text)
    && /(prompt|messages|question|query|content|chat_session|parent_message)/.test(text)
}

function isLikelyShareRequest(request: RpaCapturedRequest): boolean {
  if (request.method === 'GET') return false
  const text = `${request.url}\n${request.requestBody || ''}\n${request.responseBody || ''}`.toLowerCase()
  return /share|public|conversation\/link|copy|link/.test(text)
}

function dedupeCandidates(candidates: VisualCandidate[]): VisualCandidate[] {
  const seen = new Set<string>()
  const result: VisualCandidate[] = []

  for (const candidate of candidates) {
    const key = `${Math.round(candidate.x / 8) * 8}:${Math.round(candidate.y / 8) * 8}:${candidate.role}:${candidate.label}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }

  return result
}

function describeCandidate(candidate: VisualCandidate): string {
  return `${candidate.label || candidate.role} (${candidate.source}, ${candidate.confidence}%)`
}

function baseRequestId(id: string): string {
  return id.replace(/:(started|response|completed|failed)$/i, '')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
