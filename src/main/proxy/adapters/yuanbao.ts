import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import type { Account, Provider } from '../../store/types.ts'
import type { ChatMessage } from '../types.ts'
import { applyAxiosProxyConfig, type OutboundProxyContext } from '../proxyTransport.ts'

const BASE_URL = 'https://yuanbao.tencent.com'
const DEFAULT_AGENT_ID = 'naQivTmsDa'

interface YuanbaoChatRequest {
  model: string
  originalModel?: string
  messages: ChatMessage[]
  webSearch?: boolean
  enableThinking?: boolean
}

export interface YuanbaoResponseMetadata {
  conversation_id: string
  message_id: string
  conversation_url: string
  share_url: string
  answer_content: string
  reasoning_content: string
  citations: any[] | string
  source_list: any[] | string
  search_results: { keywords: string[]; webPages: any[] } | string
  related_searches: string[] | string
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => part.type === 'text' ? (part.text || '') : '').filter(Boolean).join('\n')
}

function buildPrompt(messages: ChatMessage[]): string {
  return messages.map(message => {
    const content = contentToText(message.content).trim()
    if (!content) return ''
    if (message.role === 'user') return content
    return `${message.role}: ${content}`
  }).filter(Boolean).join('\n\n')
}

function resolveModel(model: string, thinking: boolean): { model: string; chatModelId: string; subModelId: string } {
  const normalized = model.toLowerCase()
  if (normalized.includes('deepseek')) {
    const r1 = thinking || normalized.includes('r1')
    return { model: r1 ? 'deep_seek' : 'deep_seek_v3', chatModelId: r1 ? 'deep_seek' : 'deep_seek_v3', subModelId: '' }
  }
  const t1 = thinking || normalized.includes('t1')
  return { model: 'gpt_175B_0404', chatModelId: t1 ? 'hunyuan_t1' : 'hunyuan_gpt_175B_0404', subModelId: t1 ? 'hunyuan_t1' : '' }
}

export function collectYuanbaoDetailMetadata(detail: any): Pick<YuanbaoResponseMetadata, 'answer_content' | 'reasoning_content' | 'citations' | 'source_list' | 'search_results'> {
  const reasoning: string[] = []
  const answer: string[] = []
  const citations: any[] = []
  const seenUrls = new Set<string>()
  const speeches = (detail?.convs || []).flatMap((conv: any) => conv?.speechesV2 || conv?.spechesV2 || [])

  const addDocs = (docs: any) => {
    if (!Array.isArray(docs)) return
    for (const doc of docs) {
      if (!doc || typeof doc.url !== 'string' || typeof doc.title !== 'string' || seenUrls.has(doc.url)) continue
      seenUrls.add(doc.url)
      citations.push({ ...doc, index: Number.isFinite(doc.index) ? doc.index : citations.length + 1 })
    }
  }

  for (const speech of speeches) {
    for (const item of speech?.content || []) {
      addDocs(item?.docs)
      if (item?.type === 'deepSearch') {
        for (const component of item?.contents || []) {
          if (component?.type === 'text' && typeof component.msg === 'string' && component.msg) reasoning.push(component.msg)
          addDocs(component?.docs)
        }
        continue
      }
      if (item?.type === 'searchGuid') continue
      for (const key of ['msg', 'text', 'content', 'markdown']) {
        if (typeof item?.[key] === 'string' && item[key]) {
          answer.push(item[key])
          break
        }
      }
    }
  }

  const citationValue = citations.length > 0 ? citations.sort((a, b) => a.index - b.index) : ''
  return {
    answer_content: answer.join(''),
    reasoning_content: reasoning.join(''),
    citations: citationValue,
    source_list: citationValue,
    search_results: citations.length > 0 ? { keywords: [], webPages: citations } : '',
  }
}

export class YuanbaoAdapter {
  private client: AxiosInstance
  private account: Account
  private agentId: string

  constructor(_provider: Provider, account: Account, outboundProxy?: OutboundProxyContext) {
    this.account = account
    this.agentId = account.credentials.agent_id || account.credentials.agentId || DEFAULT_AGENT_ID
    this.client = axios.create(applyAxiosProxyConfig({ timeout: 180000, maxBodyLength: Infinity }, outboundProxy))
  }

  static isYuanbaoProvider(provider: Provider): boolean {
    return provider.id === 'yuanbao' || provider.apiEndpoint?.includes('yuanbao.tencent.com')
  }

  async chatCompletion(request: YuanbaoChatRequest): Promise<{
    response: AxiosResponse<NodeJS.ReadableStream>
    sessionId: string
    metadataProvider: (messageId?: string) => Promise<YuanbaoResponseMetadata>
  }> {
    const prompt = buildPrompt(request.messages)
    if (!prompt) throw new Error('No prompt text found in request messages')

    const headers = this.createHeaders(this.agentId)
    const createResponse = await this.client.post(`${BASE_URL}/api/user/agent/conversation/create`, { agentId: this.agentId }, { headers })
    const sessionId = createResponse.data?.id
    if (!sessionId) throw new Error('Yuanbao conversation creation did not return an id')

    const modelInfo = resolveModel(request.originalModel || request.model, request.enableThinking === true)
    const webSearch = request.webSearch === true
    const internetSearch = webSearch ? 'openInternetSearch' : 'closeInternetSearch'
    const supportFunctions = webSearch
      ? ['openAutoSearchSwitch', 'openInternetSearch']
      : ['openAutoSearchSwitch', 'closeInternetSearch']
    const body = {
      model: modelInfo.model,
      prompt,
      plugin: 'Adaptive',
      displayPrompt: prompt,
      displayPromptType: 1,
      agentId: this.agentId,
      isTemporary: false,
      projectId: '',
      chatModelId: modelInfo.chatModelId,
      supportFunctions,
      docOpenid: '',
      options: { imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true } },
      multimedia: [],
      supportHint: 1,
      chatModelExtInfo: JSON.stringify({
        modelId: modelInfo.model,
        subModelId: modelInfo.subModelId,
        supportFunctions: { internetSearch: '' },
        internetSearch,
      }),
      applicationIdList: [],
      version: 'v2',
      extReportParams: null,
      isAtomInput: false,
      conversationId: sessionId,
      offsetOfHour: 8,
      offsetOfMinute: 0,
    }

    const response = await this.client.post(`${BASE_URL}/api/chat/${sessionId}`, body, {
      headers: this.createHeaders(this.agentId, sessionId, true),
      responseType: 'stream',
      validateStatus: () => true,
    })
    const headerMessageId = String(response.headers['x-answer-msgid'] || '')
    return {
      response,
      sessionId,
      metadataProvider: messageId => this.fetchMetadata(sessionId, messageId || headerMessageId, prompt),
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.client.post(`${BASE_URL}/api/user/agent/conversation/v1/clear`, {
      conversationIds: [sessionId], uiOptions: { noToast: true },
    }, { headers: this.createHeaders(`${this.agentId}/${sessionId}`) })
    return true
  }

  private async fetchMetadata(sessionId: string, messageId: string, prompt: string): Promise<YuanbaoResponseMetadata> {
    const base: YuanbaoResponseMetadata = {
      conversation_id: sessionId,
      message_id: messageId || '',
      conversation_url: `${BASE_URL}/chat/${this.agentId}/${sessionId}`,
      share_url: '',
      answer_content: '', reasoning_content: '', citations: '', source_list: '', search_results: '', related_searches: '',
    }
    const headers = this.createHeaders(`${this.agentId}/${sessionId}`)
    let detail: any
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.client.post(`${BASE_URL}/api/user/agent/conversation/v1/detail`, {
          conversationId: sessionId, offset: 0, limit: 10, agentId: this.agentId,
        }, { headers })
        detail = response.data
        if ((detail?.convs || []).length > 0) break
      } catch (error) {
        console.warn('[Yuanbao] Failed to fetch conversation detail:', error)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    const result = { ...base, ...collectYuanbaoDetailMetadata(detail) }
    try {
      const listResponse = await this.client.post(`${BASE_URL}/api/user/agent/conversation/list`, {
        agentId: this.agentId, offset: 0, limit: 5, filterGoodQuestion: true,
      }, { headers })
      const conversation = (listResponse.data?.conversations || []).find((item: any) => item?.id === sessionId)
      if (!result.answer_content && typeof conversation?.lastReplyContent === 'string') {
        result.answer_content = conversation.lastReplyContent
      }
    } catch (error) {
      console.warn('[Yuanbao] Failed to fetch conversation list fallback:', error)
    }
    try {
      const hintResponse = await this.client.post(`${BASE_URL}/api/user/agent/conversation/hintV2`, {
        hintType: '', conversationId: sessionId, msgId: messageId, speechIndex: 1,
      }, { headers })
      const hints = hintResponse.data?.data?.hints
      if (Array.isArray(hints)) {
        const related = hints.map((hint: any) => hint?.prompt).filter((value: any) => typeof value === 'string' && value)
        result.related_searches = related.length > 0 ? related : ''
      }
    } catch {
      try {
        const fallback = await this.client.post(`${BASE_URL}/api/user/agent/conversation/promptSug`, { prompt }, { headers })
        const suggestions = fallback.data?.data?.sug
        result.related_searches = Array.isArray(suggestions) && suggestions.length > 0 ? suggestions : ''
      } catch (error) {
        console.warn('[Yuanbao] Failed to fetch related searches:', error)
      }
    }
    return result
  }

  private createHeaders(agentId: string, sessionId?: string, stream = false): Record<string, string> {
    const credentials = this.account.credentials
    const xUskey = credentials.x_uskey || credentials.xUskey || credentials['x-uskey'] || ''
    return {
      Accept: stream ? '*/*' : 'application/json, text/plain, */*',
      'Content-Type': stream ? 'text/plain;charset=UTF-8' : 'application/json',
      Cookie: credentials.cookie || '',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/chat/${this.agentId}${sessionId ? `/${sessionId}` : ''}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
      'X-AgentID': agentId,
      'X-Uskey': xUskey,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Source': 'web',
      'X-Web-Third-Source': 'main',
      'X-Language': 'zh-CN',
      'X-Platform': 'mac',
      'chat_version': 'v1',
    }
  }
}

export const yuanbaoAdapter = { YuanbaoAdapter }
