import type {
  RpaAnalysisReport,
  RpaCapturedRequest,
  RpaEndpointFinding,
  RpaLearningResult,
} from '../../shared/rpa'

const MAX_BODY_CHARS = 2400
const MAX_REQUESTS = 20

export class AnalysisReportGenerator {
  generate(result: RpaLearningResult): RpaAnalysisReport {
    const markdown = [
      '# Chat2API RPA Interface Analysis Report',
      '',
      '把这份报告交给 AI 修改源码时，请要求它只基于脱敏后的接口结构实现 provider adapter，不要恢复、猜测或硬编码任何真实凭证。',
      '',
      '## Session',
      '',
      `- Session ID: \`${result.sessionId}\``,
      `- Captured At: \`${new Date(result.capturedAt).toISOString()}\``,
      `- Target: \`${result.target.title || result.target.url}\``,
      `- URL: \`${result.target.url}\``,
      `- Origin: \`${result.origin}\``,
      result.learningTarget ? `- Learning Target: \`${result.learningTarget.name}\`` : '',
      result.learningTarget ? `- Capture Domains: ${formatInlineList(result.learningTarget.captureDomains)}` : '',
      `- Captured Requests: \`${result.requests.length}\``,
      '',
      this.renderWarnings(result),
      this.renderPrimaryChat(result.primaryChat),
      this.renderFindings(result.findings),
      this.renderRequests(result.requests),
      this.renderImplementationPrompt(result),
      this.renderJsonAppendix(result),
    ].filter(Boolean).join('\n')

    return {
      sessionId: result.sessionId,
      generatedAt: Date.now(),
      markdown,
    }
  }

  private renderWarnings(result: RpaLearningResult): string {
    if (result.warnings.length === 0) {
      return '## Warnings\n\n- None\n'
    }

    return [
      '## Warnings',
      '',
      ...result.warnings.map((warning) => `- ${warning}`),
      '',
    ].join('\n')
  }

  private renderPrimaryChat(primaryChat: RpaEndpointFinding | undefined): string {
    if (!primaryChat) {
      return [
        '## Primary Chat Endpoint',
        '',
        '- Not detected with high confidence.',
        '',
      ].join('\n')
    }

    return [
      '## Primary Chat Endpoint',
      '',
      `- Method: \`${primaryChat.method}\``,
      `- URL: \`${primaryChat.url}\``,
      `- Path: \`${primaryChat.path}\``,
      `- Confidence: \`${primaryChat.confidence}%\``,
      `- Streaming: \`${primaryChat.isStreaming ? 'yes' : 'no'}\``,
      `- Auth Headers: ${formatInlineList(primaryChat.authHeaders)}`,
      `- Auth Query Params: ${formatInlineList(primaryChat.authQueryParams || [])}`,
      `- Request Shape: ${formatInlineList(primaryChat.requestShape || [])}`,
      `- Response Shape: ${formatInlineList(primaryChat.responseShape || [])}`,
      `- Reasons: ${formatInlineList(primaryChat.reasons)}`,
      '',
    ].join('\n')
  }

  private renderFindings(findings: RpaEndpointFinding[]): string {
    if (findings.length === 0) {
      return '## Endpoint Findings\n\n- No endpoint findings.\n'
    }

    return [
      '## Endpoint Findings',
      '',
      ...findings.slice(0, 12).map((finding, index) => [
        `### ${index + 1}. ${finding.kind.toUpperCase()} ${finding.method} ${finding.path}`,
        '',
        `- URL: \`${finding.url}\``,
        `- Status: \`${finding.status || '-'}\``,
        `- Confidence: \`${finding.confidence}%\``,
        `- Streaming: \`${finding.isStreaming ? 'yes' : 'no'}\``,
        `- Auth Headers: ${formatInlineList(finding.authHeaders)}`,
        `- Auth Query Params: ${formatInlineList(finding.authQueryParams || [])}`,
        `- Request Shape: ${formatInlineList(finding.requestShape || [])}`,
        `- Response Shape: ${formatInlineList(finding.responseShape || [])}`,
        `- Models: ${formatInlineList(finding.models || [])}`,
        `- Reasons: ${formatInlineList(finding.reasons)}`,
        '',
      ].join('\n')),
    ].join('\n')
  }

  private renderRequests(requests: RpaCapturedRequest[]): string {
    if (requests.length === 0) {
      return '## Captured Request Samples\n\n- No captured request samples.\n'
    }

    return [
      '## Captured Request Samples',
      '',
      ...requests.slice(0, MAX_REQUESTS).map((request, index) => [
        `### ${index + 1}. ${request.method} ${safePath(request.url)}`,
        '',
        `- URL: \`${request.url}\``,
        `- Lifecycle: \`${request.lifecycle || '-'}\``,
        `- Status: \`${request.status || '-'}\``,
        `- Resource Type: \`${request.resourceType}\``,
        `- MIME: \`${request.mimeType || '-'}\``,
        `- Event Stream: \`${request.isEventStream ? 'yes' : 'no'}\``,
        '',
        '**Request Headers**',
        '',
        fencedJson(request.requestHeaders),
        '',
        '**Response Headers**',
        '',
        fencedJson(request.responseHeaders),
        '',
        '**Request Body Sample**',
        '',
        fencedText(request.requestBody),
        '',
        '**Response Body Sample**',
        '',
        fencedText(request.responseBody),
        '',
      ].join('\n')),
    ].join('\n')
  }

  private renderImplementationPrompt(result: RpaLearningResult): string {
    return [
      '## Suggested AI Implementation Instruction',
      '',
      '请基于本报告为 Chat2API 实现或修正 provider：',
      '',
      '- 根据 Primary Chat Endpoint 实现 provider config、proxy adapter 和 stream handler。',
      '- 鉴权字段只能使用项目已有 account credentials，不能把报告中的脱敏值当作真实值。',
      '- streaming 响应需要转换为 OpenAI-compatible SSE chunk；非 streaming 响应需要转换为 OpenAI chat completion JSON。',
      '- 若报告中出现 session/conversation/thread 字段，接入项目现有 sessionManager。',
      '- 修改后运行 `npm run build`，并用一次 streaming 与一次 non-streaming 请求做验证。',
      '- 不要直接覆盖内置 provider，除非用户明确指定要修改哪个 provider。',
      '',
      result.primaryChat
        ? `优先实现的接口是：\`${result.primaryChat.method} ${result.primaryChat.url}\`。`
        : '当前没有足够高置信度的 chat endpoint，建议重新录制一次包含完整提问、回答完成、分享的流程。',
      '',
    ].join('\n')
  }

  private renderJsonAppendix(result: RpaLearningResult): string {
    return [
      '## Compact JSON Appendix',
      '',
      fencedJson({
        sessionId: result.sessionId,
        origin: result.origin,
        target: result.target,
        learningTarget: result.learningTarget,
        primaryChat: result.primaryChat,
        findings: result.findings.slice(0, 12),
        requests: result.requests.slice(0, MAX_REQUESTS).map((request) => ({
          id: request.id,
          lifecycle: request.lifecycle,
          method: request.method,
          url: request.url,
          resourceType: request.resourceType,
          status: request.status,
          mimeType: request.mimeType,
          isEventStream: request.isEventStream,
          requestHeaders: request.requestHeaders,
          responseHeaders: request.responseHeaders,
          requestBody: truncate(request.requestBody),
          responseBody: truncate(request.responseBody),
        })),
        warnings: result.warnings,
      }),
      '',
    ].join('\n')
  }
}

function formatInlineList(values: string[]): string {
  if (values.length === 0) {
    return '`-`'
  }

  return values.slice(0, 20).map((value) => `\`${value}\``).join(', ')
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function fencedText(value: string | undefined): string {
  return `\`\`\`text\n${truncate(value) || '-'}\n\`\`\``
}

function truncate(value: string | undefined): string {
  if (!value) {
    return ''
  }

  if (value.length <= MAX_BODY_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_BODY_CHARS)}...[report truncated ${value.length - MAX_BODY_CHARS} chars]`
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}
