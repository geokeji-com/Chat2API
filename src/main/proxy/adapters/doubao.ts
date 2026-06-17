/**
 * Doubao Adapter
 * Uses an Electron hidden page to let Doubao's web runtime inject msToken/a_bogus.
 */

import { BrowserWindow, session as electronSession, type Session } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { PassThrough, Readable } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types'
import { localRelayProxyManager, type LocalRelayProxyHandle } from '../localRelayProxy'
import type { OutboundProxyContext } from '../proxyTransport'

const DOUBAO_WEB_BASE = 'https://www.doubao.com'
const DOUBAO_CHAT_URL = `${DOUBAO_WEB_BASE}/chat/`
const DOUBAO_COMPLETION_URL = `${DOUBAO_WEB_BASE}/chat/completion`
const DOUBAO_SHARE_TOKEN_URL = `${DOUBAO_WEB_BASE}/im/message/share/share_token`
const DOUBAO_SHARE_SAVE_URL = `${DOUBAO_WEB_BASE}/im/message/share/save`
const DOUBAO_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const DOUBAO_PC_VERSION = '3.23.3'
const DEFAULT_DOUBAO_BOT_ID = '7338286299411103781'
const DOUBAO_STREAM_CHUNK_PREFIX = '__CHAT2API_DOUBAO_CHUNK__'
const DOUBAO_BOT_ID_ALIASES: Record<string, string> = {
  doubao: DEFAULT_DOUBAO_BOT_ID,
  'doubao-pro': DEFAULT_DOUBAO_BOT_ID,
  'doubao-lite': DEFAULT_DOUBAO_BOT_ID,
  'doubao-thinking': DEFAULT_DOUBAO_BOT_ID,
}

interface DoubaoChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
}

interface DoubaoBrowserFetchResult {
  status: number
  body: string
  body_len?: number
  fetch_hook?: string
  url?: string
  hooked?: boolean
  page_url?: string
}

interface DoubaoBrowserShareAttempt {
  endpoint: string
  status: number
  url?: string
  body?: string
  json?: any
  request?: any
}

interface DoubaoBrowserShareResult {
  share_url?: string
  share_id?: string
  error?: string
  attempts?: DoubaoBrowserShareAttempt[]
}

export interface DoubaoResponseMetadata {
  conversation_id?: string
  local_conversation_id?: string
  section_id?: string
  message_id?: string
  conversation_url?: string
  share_url?: string
  share_id?: string
  share_error?: string
}

interface DoubaoSessionState {
  sessionId: string
  localConversationId: string
  conversationId: string
  sectionId: string
  lastMessageIndex: number | null
  botId: string
}

interface ParsedDoubaoConversationMeta {
  conversationId?: string
  localConversationId?: string
  sectionId?: string
  messageId?: string
  messageIndex?: number
}

const JS_STREAM_DOUBAO = `
async (args) => {
  const findFp = () => {
    if (args.fp) return args.fp;
    // prefer s_v_web_id cookie (wangchu-style)
    const fpCookie = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('s_v_web_id='));
    if (fpCookie) return fpCookie.split('=')[1] || '';
    const values = [location.href, document.cookie];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        values.push(key || '', localStorage.getItem(key) || '');
      }
    } catch (_) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        values.push(key || '', sessionStorage.getItem(key) || '');
      }
    } catch (_) {}
    const match = values.join('\\n').match(/verify_[A-Za-z0-9_-]+/);
    return match ? match[0] : '';
  };

  const emitStreamChunk = text => {
    if (!args.streamTraceId || !text) return;
    try {
      const bytes = new TextEncoder().encode(text);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      console.log('${DOUBAO_STREAM_CHUNK_PREFIX}' + JSON.stringify({
        traceId: args.streamTraceId,
        b64: btoa(binary),
      }));
    } catch (_) {}
  };

  const extractDeviceParams = () => {
    let deviceId = '', webId = '';
    try {
      const params = new URLSearchParams(location.search);
      deviceId = params.get('device_id') || '';
      webId = params.get('web_id') || '';
    } catch (_) {}
    try {
      const samWeb = JSON.parse(localStorage.getItem('samantha_web_web_id') || '{}');
      deviceId = deviceId || samWeb.device_id || samWeb.web_id || '';
      webId = webId || samWeb.web_id || samWeb.device_id || '';
    } catch (_) {}
    try {
      const tea = JSON.parse(localStorage.getItem('__tea_cache_tokens_497858') || '{}');
      deviceId = deviceId || tea.device_id || tea.web_id || '';
      webId = webId || tea.web_id || tea.user_unique_id || '';
    } catch (_) {}
    return { deviceId: deviceId || webId, webId: webId || deviceId };
  };

  const getWebTabId = () => {
    try {
      const existing = sessionStorage.getItem('chat2api_doubao_web_tab_id');
      if (existing) return existing;
      const created = globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
      sessionStorage.setItem('chat2api_doubao_web_tab_id', created);
      return created;
    } catch (_) {
      return '';
    }
  };

  const buildUrl = (baseUrl, fp, deviceId, webId) => {
    const params = {
      aid: '497858',
      device_id: deviceId,
      device_platform: 'web',
      fp: fp,
      language: 'zh',
      pc_version: args.pcVersion || '${DOUBAO_PC_VERSION}',
      pkg_type: 'release_version',
      real_aid: '497858',
      region: 'CN',
      samantha_web: '1',
      sys_region: 'CN',
      tea_uuid: webId,
      'use-olympus-account': '1',
      version_code: '20800',
      web_id: webId,
      web_platform: 'browser',
      web_tab_id: getWebTabId(),
    };
    const qs = Object.entries(params)
      .filter(([, v]) => v)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    return qs ? baseUrl + '?' + qs : baseUrl;
  };

  const fetchStr = window.fetch.toString().substring(0, 120);
  const hooked = !/native code/i.test(fetchStr);
  const payload = args.payload || {};
  payload.ext = payload.ext || {};
  const fp = findFp();
  if (fp) payload.ext.fp = fp;
  const { deviceId, webId } = extractDeviceParams();
  const url = buildUrl(args.url, fp, deviceId, webId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs || 180000);
  const headers = {
    'Content-Type': 'application/json',
    'Agw-Js-Conv': 'str',
    'x-flow-trace': args.traceId,
    'last-event-id': 'undefined'
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'include',
      signal: controller.signal
    });

    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      const text = await res.text();
      return { status: res.status, body: text, fetch_hook: fetchStr, hooked, page_url: location.href, url: res.url, body_len: text.length };
    }

    const decoder = new TextDecoder();
    let body = '';
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const text = decoder.decode(item.value, { stream: true });
      body += text;
      emitStreamChunk(text);
    }
    const tail = decoder.decode();
    body += tail;
    emitStreamChunk(tail);
    return { status: res.status, body, fetch_hook: fetchStr, hooked, page_url: location.href, url: res.url, body_len: body.length };
  } catch (error) {
    return {
      status: 0,
      body: error && error.message ? ('JS error: ' + error.message) : 'JS error',
      fetch_hook: fetchStr,
      hooked,
      page_url: location.href
    };
  } finally {
    clearTimeout(timer);
  }
}
`

const JS_SHARE_DOUBAO = `
async (args) => {
  const fetchStr = window.fetch.toString().substring(0, 120);
  const hooked = !/native code/i.test(fetchStr);

  const isObject = value => value && typeof value === 'object';
  const extractDeviceParams = () => {
    let deviceId = '', webId = '';
    try {
      const params = new URLSearchParams(location.search);
      deviceId = params.get('device_id') || '';
      webId = params.get('web_id') || '';
    } catch (_) {}
    try {
      const samWeb = JSON.parse(localStorage.getItem('samantha_web_web_id') || '{}');
      deviceId = deviceId || samWeb.device_id || samWeb.web_id || '';
      webId = webId || samWeb.web_id || samWeb.device_id || '';
    } catch (_) {}
    try {
      const tea = JSON.parse(localStorage.getItem('__tea_cache_tokens_497858') || '{}');
      deviceId = deviceId || tea.device_id || tea.web_id || '';
      webId = webId || tea.web_id || tea.user_unique_id || '';
    } catch (_) {}
    return { deviceId: deviceId || webId, webId: webId || deviceId };
  };
  const getWebTabId = () => {
    try {
      const existing = sessionStorage.getItem('chat2api_doubao_web_tab_id');
      if (existing) return existing;
      const created = globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
      sessionStorage.setItem('chat2api_doubao_web_tab_id', created);
      return created;
    } catch (_) {
      return '';
    }
  };
  const buildApiUrl = endpoint => {
    const { deviceId, webId } = extractDeviceParams();
    const params = {
      version_code: '20800',
      language: 'zh',
      device_platform: 'web',
      aid: '497858',
      real_aid: '497858',
      pkg_type: 'release_version',
      device_id: deviceId,
      pc_version: args.pcVersion || '${DOUBAO_PC_VERSION}',
      web_id: webId,
      tea_uuid: webId,
      region: 'CN',
      sys_region: 'CN',
      samantha_web: '1',
      web_platform: 'browser',
      'use-olympus-account': '1',
      web_tab_id: getWebTabId(),
    };
    try {
      const url = new URL(endpoint, args.baseUrl);
      for (const [key, value] of Object.entries(params)) {
        if (value && !url.searchParams.has(key)) {
          url.searchParams.set(key, value);
        }
      }
      return url.toString();
    } catch (_) {
      return endpoint;
    }
  };
  const normalizeUrl = value => {
    if (typeof value !== 'string' || !value) return '';
    if (/^https?:\\/\\//i.test(value)) return value;
    if (value.startsWith('/')) return new URL(value, args.baseUrl).toString();
    return '';
  };
  const findShareValue = (value, seen = new Set()) => {
    if (!value || seen.has(value)) return {};
    if (typeof value === 'string') {
      const url = normalizeUrl(value);
      if (url && /doubao\\.com\\/(?:thread|share|chat\\/share)\\//i.test(url)) return { share_url: url };
      if (/^[A-Za-z0-9_-]{8,}$/.test(value) && !/^\\d+$/.test(value)) return { share_id: value };
      return {};
    }
    if (!isObject(value)) return {};
    seen.add(value);
    for (const key of ['share_url', 'shareUrl', 'share_link', 'shareLink', 'copy_link', 'copyLink', 'url', 'link', 'href']) {
      const url = normalizeUrl(value[key]);
      if (url && /doubao\\.com\\/(?:thread|share|chat\\/share)\\//i.test(url)) return { share_url: url };
    }
    for (const key of ['share_id', 'shareId', 'share_token', 'shareToken', 'token', 'id']) {
      if (typeof value[key] === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(value[key]) && !/^\\d+$/.test(value[key])) {
        return { share_id: value[key] };
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findShareValue(child, seen);
      if (found.share_url || found.share_id) return found;
    }
    return {};
  };

  const postJson = async (endpoint, body) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json; encoding=utf-8',
        'Agw-Js-Conv': 'str',
      },
      body: JSON.stringify(body || {}),
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    const found = findShareValue(json || text);
    return { status: res.status, url: res.url, body: text, json, request: body || {}, ...found };
  };

  const attempts = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (args.delayMs) {
    await wait(args.delayMs);
  }

  const conversationId = args.conversationId;
  const messageId = args.messageId || '';
  const messageIndex = Number.isFinite(args.messageIndex) ? args.messageIndex : undefined;
  const tokenBodies = [
    { conversation_id: conversationId },
    { conv_id: conversationId },
  ];
  const saveBodies = [
    {
      conv_id: conversationId,
      ...(messageId ? { message_id_list: [messageId] } : {}),
      ...(messageIndex !== undefined ? { message_index_list: [messageIndex] } : {}),
      enable_generate_title: true,
      is_allow_seo: true,
      share_total_conversation: true,
    },
    {
      conversation_id: conversationId,
      ...(messageId ? { message_id_list: [messageId] } : {}),
      ...(messageIndex !== undefined ? { message_index_list: [messageIndex] } : {}),
      enable_generate_title: true,
      is_allow_seo: true,
      share_total_conversation: true,
    },
  ];

  try {
    const infoUrl = buildApiUrl(args.infoUrl);
    const saveUrl = buildApiUrl(args.saveUrl);

    for (const body of tokenBodies) {
      const result = await postJson(infoUrl, body);
      attempts.push({ endpoint: 'info', ...result });
      const shareToken = result.share_id || result.share_token || result.shareToken || result.json?.data?.share_token || result.json?.data?.shareToken;
      const expandedSaveBodies = shareToken
        ? saveBodies.map(saveBody => ({ ...saveBody, share_token: shareToken }))
        : saveBodies;

      for (const saveBody of expandedSaveBodies) {
        const saveResult = await postJson(saveUrl, saveBody);
        attempts.push({ endpoint: 'save', ...saveResult });
        if (saveResult.share_url) {
          return { hooked, fetch_hook: fetchStr, page_url: location.href, attempts, share_url: saveResult.share_url || '', share_id: saveResult.share_id || '' };
        }
      }
    }

    for (const body of saveBodies) {
      const result = await postJson(saveUrl, body);
      attempts.push({ endpoint: 'save', ...result });
      if (result.share_url) {
        return { hooked, fetch_hook: fetchStr, page_url: location.href, attempts, share_url: result.share_url || '', share_id: result.share_id || '' };
      }
    }

    return { hooked, fetch_hook: fetchStr, page_url: location.href, attempts };
  } catch (error) {
    return {
      hooked,
      fetch_hook: fetchStr,
      page_url: location.href,
      attempts,
      error: error && error.message ? error.message : String(error || 'share failed'),
    };
  }
}
`

function uuid(): string {
  return randomUUID()
}

function randomHex(bytes: number = 8): string {
  return randomBytes(bytes).toString('hex')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => {
      if (part.type === 'text') return part.text || ''
      if (part.type === 'image_url') return part.image_url?.url ? `[image: ${part.image_url.url}]` : ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function buildPrompt(messages: ChatMessage[]): string {
  const textParts = messages
    .map(message => {
      const content = contentToText(message.content).trim()
      if (!content) return ''

      if (message.role === 'user') return content
      if (message.role === 'system') return `System:\n${content}`
      if (message.role === 'assistant') return `Assistant:\n${content}`
      if (message.role === 'tool') return `Tool${message.name ? ` (${message.name})` : ''}:\n${content}`
      return content
    })
    .filter(Boolean)

  return textParts.join('\n\n')
}

function parseCookieHeader(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const rawPart of cookieHeader.split(';')) {
    const part = rawPart.trim()
    if (!part) continue
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name && value) {
      cookies[name] = value
    }
  }
  return cookies
}

function getCredentialCookieMap(credentials: Record<string, string>): Record<string, string> {
  const cookies = credentials.cookie ? parseCookieHeader(credentials.cookie) : {}
  const sessionid = credentials.sessionid || credentials.sessionId || cookies.sessionid

  if (sessionid) {
    cookies.sessionid = sessionid
    cookies.sessionid_ss = cookies.sessionid_ss || sessionid
    cookies.sid_tt = cookies.sid_tt || sessionid
    cookies.sid_guard = cookies.sid_guard || sessionid
  }

  return cookies
}

function createSessionState(botId: string): DoubaoSessionState {
  const now = Date.now()
  return {
    sessionId: uuid(),
    localConversationId: `local_${now}${randomHex(3)}`,
    conversationId: '',
    sectionId: '',
    lastMessageIndex: null,
    botId,
  }
}

function resolveDoubaoBotId(model: string): string {
  const trimmed = String(model || '').trim()
  if (/^\d+$/.test(trimmed)) {
    return trimmed
  }

  return DOUBAO_BOT_ID_ALIASES[trimmed.toLowerCase()] || DEFAULT_DOUBAO_BOT_ID
}

function createDoubaoConversationUrl(conversationId: string): string {
  return `${DOUBAO_WEB_BASE}/chat/${encodeURIComponent(conversationId)}`
}

function createDoubaoThreadShareUrl(shareId: string): string {
  return `${DOUBAO_WEB_BASE}/thread/${encodeURIComponent(shareId)}`
}

function normalizeDoubaoShareUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  if (/^https?:\/\//i.test(value) && /doubao\.com\/(?:thread|share|chat\/share)\//i.test(value)) {
    return value
  }
  if (value.startsWith('/')) {
    const url = new URL(value, DOUBAO_WEB_BASE).toString()
    return /doubao\.com\/(?:thread|share|chat\/share)\//i.test(url) ? url : ''
  }
  return ''
}

function normalizeShareId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || /^\d+$/.test(trimmed)) return ''
  return /^[A-Za-z0-9_-]{8,}$/.test(trimmed) ? trimmed : ''
}

function createDoubaoMetadataSSE(metadata: DoubaoResponseMetadata): string {
  return `event: CHAT2API_METADATA\ndata: ${JSON.stringify(metadata)}\n\n`
}

function sanitizePartitionId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_')
}

function parseJSONSafe(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function findShareInfoInValue(value: any, seen = new Set<any>()): { share_url?: string; share_id?: string } {
  if (!value) return {}

  if (typeof value === 'string') {
    const parsed = parseJSONSafe(value)
    if (parsed && parsed !== value) {
      const found = findShareInfoInValue(parsed, seen)
      if (found.share_url || found.share_id) return found
    }

    const url = normalizeDoubaoShareUrl(value)
    if (url) return { share_url: url }

    const shareId = normalizeShareId(value)
    if (shareId) return { share_id: shareId }
    return {}
  }

  if (typeof value !== 'object' || seen.has(value)) return {}
  seen.add(value)

  for (const key of ['share_url', 'shareUrl', 'share_link', 'shareLink', 'copy_link', 'copyLink', 'url', 'link', 'href']) {
    const url = normalizeDoubaoShareUrl(value[key])
    if (url) return { share_url: url }
  }

  for (const key of ['share_id', 'shareId', 'share_token', 'shareToken', 'token', 'id']) {
    const shareId = normalizeShareId(value[key])
    if (shareId) return { share_id: shareId }
  }

  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    const found = findShareInfoInValue(child, seen)
    if (found.share_url || found.share_id) return found
  }

  return {}
}

function parseDoubaoSSEEventBlock(block: string): { event: string; data: any } | null {
  const trimmedBlock = block.trim()
  if (!trimmedBlock) return null

  let event = ''
  const dataLines: string[] = []
  for (const rawLine of trimmedBlock.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  if (!event && dataLines.length === 0) return null
  const dataText = dataLines.join('\n')
  return {
    event,
    data: dataText && dataText !== '[DONE]' ? (parseJSONSafe(dataText) ?? dataText) : {},
  }
}

function pickDoubaoNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && /^\d+$/.test(value.trim())) {
      return Number(value.trim())
    }
  }
  return undefined
}

function pickDoubaoString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function isKnownDoubaoUserMessage(message: any, userMessageIds: Set<string>): boolean {
  const ids = [
    message?.message_id,
    message?.local_message_id,
    message?.id,
    message?.meta?.message_id,
    message?.meta?.local_message_id,
  ]
  if (ids.some(id => id && userMessageIds.has(String(id)))) {
    return true
  }

  const role = pickDoubaoString(message?.role, message?.sender_role, message?.message_role, message?.sender?.role)
  if (/user|human/i.test(role)) return true

  const messageType = pickDoubaoString(message?.message_type, message?.type, message?.sender_type)
  return /user|human/i.test(messageType)
}

function applyAssistantMessageMeta(meta: ParsedDoubaoConversationMeta, message: any, userMessageIds: Set<string>): void {
  if (!message || typeof message !== 'object' || isKnownDoubaoUserMessage(message, userMessageIds)) return

  const messageMeta = message.meta || {}
  if (message.message_id || messageMeta.message_id) {
    meta.messageId = message.message_id || messageMeta.message_id
  }
  if ((message.section_id || messageMeta.section_id) && !meta.sectionId) {
    meta.sectionId = message.section_id || messageMeta.section_id
  }

  const messageIndex = pickDoubaoNumber(
    message.index_in_conv,
    messageMeta.index_in_conv,
    message.message_index,
    messageMeta.message_index,
  )
  if (messageIndex !== undefined) {
    meta.messageIndex = messageIndex
  }
}

function extractConversationMetaFromRawSSE(rawBody: string): ParsedDoubaoConversationMeta {
  const meta: ParsedDoubaoConversationMeta = {}
  const userMessageIds = new Set<string>()
  const normalized = rawBody.replace(/\r\n/g, '\n')

  for (const block of normalized.split(/\n\n+/)) {
    const event = parseDoubaoSSEEventBlock(block)
    if (!event) continue

    if (event.event === 'SSE_ACK') {
      const ack = event.data?.ack_client_meta || {}
      if (ack.conversation_id && ack.conversation_id !== '0') {
        meta.conversationId = ack.conversation_id
      }
      if (ack.local_conversation_id) {
        meta.localConversationId = ack.local_conversation_id
      }
      if (ack.section_id) {
        meta.sectionId = ack.section_id
      }
      for (const item of Array.isArray(event.data?.query_list) ? event.data.query_list : []) {
        if (item?.question_id) userMessageIds.add(String(item.question_id))
        if (item?.local_message_id) userMessageIds.add(String(item.local_message_id))
      }
    } else if (event.event === 'STREAM_MSG_NOTIFY') {
      const streamMeta = event.data?.meta || {}
      applyAssistantMessageMeta(meta, { ...event.data, meta: streamMeta }, userMessageIds)
    } else if (event.event === 'FULL_MSG_NOTIFY') {
      applyAssistantMessageMeta(meta, event.data?.message || event.data, userMessageIds)
    }
  }

  return meta
}

export class DoubaoAdapter {
  private provider: Provider
  private account: Account
  private outboundProxy?: OutboundProxyContext

  constructor(provider: Provider, account: Account, outboundProxy?: OutboundProxyContext) {
    this.provider = provider
    this.account = account
    this.outboundProxy = outboundProxy
  }

  static isDoubaoProvider(provider: Provider): boolean {
    return provider.id === 'doubao'
      || provider.name?.toLowerCase().includes('doubao')
      || provider.apiEndpoint?.includes('doubao.com')
  }

  async chatCompletion(request: DoubaoChatCompletionRequest): Promise<{
    stream: NodeJS.ReadableStream
    sessionId: string
    metadata: DoubaoResponseMetadata
  }> {
    const prompt = buildPrompt(request.messages)
    if (!prompt) {
      throw new Error('No prompt text found in request messages')
    }

    const cookies = getCredentialCookieMap(this.account.credentials)
    if (!cookies.sessionid) {
      throw new Error('Doubao sessionid is not configured. Please add sessionid or a full Cookie header.')
    }

    const botId = resolveDoubaoBotId(request.model)
    const sessionState = createSessionState(botId)
    const payload = this.buildPayload(sessionState, prompt, request.enableThinking === true)

    if (request.stream === true) {
      const stream = await this.fetchInHiddenBrowserStream(payload, cookies)
      return {
        stream,
        sessionId: sessionState.sessionId,
        metadata: {},
      }
    }

    const { result, metadata } = await this.fetchInHiddenBrowser(payload, cookies)

    if (!result.status || result.status >= 400) {
      const hookHint = result.fetch_hook ? ` fetch=${result.fetch_hook}` : ''
      const urlHint = result.url ? ` url=${result.url}` : ''
      throw new Error(`Doubao request failed: HTTP ${result.status || 0}: ${result.body.slice(0, 500)}${urlHint}${hookHint}`)
    }

    return {
      stream: Readable.from([result.body]),
      sessionId: sessionState.sessionId,
      metadata,
    }
  }

  async deleteSession(_sessionId: string): Promise<boolean> {
    return true
  }

  private buildPayload(sessionState: DoubaoSessionState, text: string, enableThinking: boolean): Record<string, unknown> {
    const nowMs = Date.now()
    const isNew = !sessionState.conversationId
    const messageId = uuid()
    const blockId = uuid()
    const fp = this.account.credentials.fp || ''

    return {
      client_meta: {
        local_conversation_id: sessionState.localConversationId,
        conversation_id: sessionState.conversationId,
        bot_id: sessionState.botId,
        last_section_id: sessionState.sectionId,
        last_message_index: isNew ? null : sessionState.lastMessageIndex,
      },
      messages: [
        {
          local_message_id: messageId,
          content_block: [
            {
              block_type: 10000,
              content: {
                text_block: {
                  text,
                  icon_url: '',
                  icon_url_dark: '',
                  summary: '',
                },
                pc_event_block: '',
              },
              block_id: blockId,
              parent_id: '',
              meta_info: [],
              append_fields: [],
            },
          ],
          message_status: 0,
        },
      ],
      option: {
        send_message_scene: '',
        create_time_ms: nowMs,
        collect_id: '',
        is_audio: false,
        answer_with_suggest: false,
        tts_switch: false,
        need_deep_think: enableThinking ? 1 : 0,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuid(),
        start_seq: 0,
        need_create_conversation: isNew,
        conversation_init_option: { need_ack_conversation: true },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        is_ai_playground: false,
        is_old_user: true,
        recovery_option: {
          is_recovery: false,
          req_create_time_sec: Math.floor(nowMs / 1000),
          append_sse_event_scene: 0,
        },
        message_storage_type: 0,
      },
      user_context: [],
      ext: {
        use_deep_think: enableThinking ? '1' : '0',
        fp,
        sub_conv_firstmet_type: '1',
        collection_id: '',
        conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
        commerce_credit_config_enable: '0',
      },
    }
  }

  private async fetchInHiddenBrowser(
    payload: Record<string, unknown>,
    cookies: Record<string, string>
  ): Promise<{ result: DoubaoBrowserFetchResult; metadata: DoubaoResponseMetadata }> {
    const partition = `persist:${sanitizePartitionId(`doubao-${this.account.id}`)}`
    const browserSession = electronSession.fromPartition(partition)
    let relayHandle: LocalRelayProxyHandle | undefined
    let win: BrowserWindow | undefined

    try {
      if (this.outboundProxy) {
        relayHandle = await this.configureProxy(browserSession)
      }

      await this.injectCookies(browserSession, cookies)

      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          javascript: true,
        },
      })

      win.webContents.setUserAgent(DOUBAO_USER_AGENT)
      await this.loadDoubaoPage(win)
      const hookState = await this.waitForDoubaoFetchHook(win)
      if (!hookState.hooked) {
        console.warn('[Doubao] window.fetch still looks native; continuing so the response can expose diagnostics:', hookState)
      }

      const args = {
        url: DOUBAO_COMPLETION_URL,
        payload,
        traceId: randomHex(16),
        fp: this.account.credentials.fp || '',
        timeoutMs: 180000,
      }
      const script = `(${JS_STREAM_DOUBAO})(${JSON.stringify(args)})`
      const result = await win.webContents.executeJavaScript(script, true) as DoubaoBrowserFetchResult
      const normalizedResult = {
        status: Number(result?.status || 0),
        body: String(result?.body || ''),
        body_len: result?.body_len,
        fetch_hook: result?.fetch_hook,
        hooked: result?.hooked,
        page_url: result?.page_url,
        url: result?.url,
      }
      const metadata = await this.createResponseMetadata(win, normalizedResult.body)
      return {
        result: normalizedResult,
        metadata,
      }
    } finally {
      if (win && !win.isDestroyed()) {
        win.close()
      }
      relayHandle?.release()
    }
  }

  private async fetchInHiddenBrowserStream(
    payload: Record<string, unknown>,
    cookies: Record<string, string>
  ): Promise<NodeJS.ReadableStream> {
    const partition = `persist:${sanitizePartitionId(`doubao-${this.account.id}`)}`
    const browserSession = electronSession.fromPartition(partition)
    let relayHandle: LocalRelayProxyHandle | undefined
    let win: BrowserWindow | undefined
    const rawStream = new PassThrough()
    const rawChunks: Buffer[] = []
    const streamTraceId = randomHex(16)

    try {
      if (this.outboundProxy) {
        relayHandle = await this.configureProxy(browserSession)
      }

      await this.injectCookies(browserSession, cookies)

      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        autoHideMenuBar: true,
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          javascript: true,
        },
      })

      win.webContents.setUserAgent(DOUBAO_USER_AGENT)
      await this.loadDoubaoPage(win)
      const hookState = await this.waitForDoubaoFetchHook(win)
      if (!hookState.hooked) {
        console.warn('[Doubao] window.fetch still looks native; continuing so the response can expose diagnostics:', hookState)
      }

      win.webContents.on('console-message', (_event: any, _level: any, message: string) => {
        if (typeof message !== 'string' || !message.startsWith(DOUBAO_STREAM_CHUNK_PREFIX)) return

        try {
          const payloadText = message.slice(DOUBAO_STREAM_CHUNK_PREFIX.length)
          const payloadData = JSON.parse(payloadText)
          if (payloadData?.traceId !== streamTraceId || typeof payloadData?.b64 !== 'string') return

          const chunk = Buffer.from(payloadData.b64, 'base64')
          rawChunks.push(chunk)
          rawStream.write(chunk)
        } catch (error) {
          console.warn('[Doubao] Failed to decode streamed browser chunk:', error)
        }
      })

      const args = {
        url: DOUBAO_COMPLETION_URL,
        payload,
        traceId: randomHex(16),
        streamTraceId,
        fp: this.account.credentials.fp || '',
        timeoutMs: 180000,
      }
      const script = `(${JS_STREAM_DOUBAO})(${JSON.stringify(args)})`

      void win.webContents.executeJavaScript(script, true)
        .then(async (result: DoubaoBrowserFetchResult) => {
          const body = rawChunks.length > 0 ? Buffer.concat(rawChunks).toString('utf8') : String(result?.body || '')
          if (!result?.status || result.status >= 400) {
            const hookHint = result?.fetch_hook ? ` fetch=${result.fetch_hook}` : ''
            const urlHint = result?.url ? ` url=${result.url}` : ''
            rawStream.emit('error', new Error(`Doubao request failed: HTTP ${result?.status || 0}: ${String(result?.body || '').slice(0, 500)}${urlHint}${hookHint}`))
            return
          }

          if (win && !win.isDestroyed()) {
            const metadata = await this.createResponseMetadata(win, body)
            rawStream.write(createDoubaoMetadataSSE(metadata))
          }
        })
        .catch((error: unknown) => {
          rawStream.emit('error', error instanceof Error ? error : new Error(String(error || 'Doubao stream failed')))
        })
        .finally(() => {
          rawStream.end()
          if (win && !win.isDestroyed()) {
            win.close()
          }
          relayHandle?.release()
        })

      return rawStream
    } catch (error) {
      if (win && !win.isDestroyed()) {
        win.close()
      }
      relayHandle?.release()
      throw error
    }
  }

  private async configureProxy(browserSession: Session): Promise<LocalRelayProxyHandle | undefined> {
    if (!this.outboundProxy) return undefined

    const relayHandle = await localRelayProxyManager.acquire(this.outboundProxy.node)

    await browserSession.setProxy({
      proxyRules: relayHandle.proxyRules,
      proxyBypassRules: '<-loopback>',
    })
    return relayHandle
  }

  private async injectCookies(browserSession: Session, cookies: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(cookies)) {
      if (!value) continue
      // Remove first to avoid "overwrite HttpOnly cookie" error from persistent session
      try {
        await browserSession.cookies.remove(DOUBAO_WEB_BASE, name)
      } catch (_) {}
      await browserSession.cookies.set({
        url: DOUBAO_WEB_BASE,
        name,
        value,
        domain: '.doubao.com',
        path: '/',
        secure: true,
        httpOnly: name.includes('sid') || name.includes('session'),
        sameSite: 'lax',
      })
    }
  }

  private async createResponseMetadata(win: BrowserWindow, body: string): Promise<DoubaoResponseMetadata> {
    const parsedMeta = extractConversationMetaFromRawSSE(body)
    const metadata: DoubaoResponseMetadata = {
      ...(parsedMeta.conversationId ? { conversation_id: parsedMeta.conversationId } : {}),
      ...(parsedMeta.localConversationId ? { local_conversation_id: parsedMeta.localConversationId } : {}),
      ...(parsedMeta.sectionId ? { section_id: parsedMeta.sectionId } : {}),
      ...(parsedMeta.messageId ? { message_id: parsedMeta.messageId } : {}),
      ...(parsedMeta.conversationId ? { conversation_url: createDoubaoConversationUrl(parsedMeta.conversationId) } : {}),
      share_url: '',
    }

    if (!parsedMeta.conversationId) {
      return metadata
    }

    await this.openConversationPage(win, parsedMeta.conversationId)
    await delay(2500)

    const shareInfo = await this.fetchShareInfo(win, parsedMeta)
    if (shareInfo.share_id) {
      metadata.share_id = shareInfo.share_id
    }
    if (shareInfo.share_url) {
      metadata.share_url = shareInfo.share_url
    }
    if (shareInfo.error) {
      metadata.share_error = shareInfo.error
    }

    return metadata
  }

  private async openConversationPage(win: BrowserWindow, conversationId: string): Promise<void> {
    try {
      await Promise.race([
        win.loadURL(createDoubaoConversationUrl(conversationId)),
        delay(12000).then(() => {
          throw new Error('Doubao conversation page load timeout')
        }),
      ])
      await delay(500)
    } catch (error) {
      console.warn('[Doubao] Failed to open created conversation page; continuing with API response:', error)
    }
  }

  private async fetchShareInfo(win: BrowserWindow, meta: ParsedDoubaoConversationMeta): Promise<DoubaoBrowserShareResult> {
    try {
      const args = {
        baseUrl: DOUBAO_WEB_BASE,
        infoUrl: DOUBAO_SHARE_TOKEN_URL,
        saveUrl: DOUBAO_SHARE_SAVE_URL,
        conversationId: meta.conversationId,
        messageId: meta.messageId,
        messageIndex: meta.messageIndex,
        delayMs: 1000,
      }
      const script = `(${JS_SHARE_DOUBAO})(${JSON.stringify(args)})`
      const result = await win.webContents.executeJavaScript(script, true) as DoubaoBrowserShareResult
      return this.normalizeShareResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create Doubao share link'
      console.warn('[Doubao] Failed to create share link:', message)
      return { error: message }
    }
  }

  private normalizeShareResult(result: DoubaoBrowserShareResult | undefined): DoubaoBrowserShareResult {
    if (!result) {
      return {}
    }

    const directUrl = normalizeDoubaoShareUrl(result.share_url)
    if (directUrl) {
      return { ...result, share_url: directUrl }
    }

    for (const attempt of result.attempts || []) {
      const found = findShareInfoInValue(attempt.json ?? attempt.body)
      if (found.share_url) {
        return {
          ...result,
          share_url: found.share_url,
          share_id: found.share_id,
        }
      }
    }

    const directShareId = normalizeShareId(result.share_id)
    return {
      ...result,
      ...(directShareId ? { share_id: directShareId } : {}),
      error: result.error || 'Doubao share link was not returned by share/save; manual sharing may still work after the page finishes preparing.',
    }
  }

  private async loadDoubaoPage(win: BrowserWindow): Promise<void> {
    try {
      await Promise.race([
        win.loadURL(DOUBAO_CHAT_URL),
        delay(30000).then(() => {
          throw new Error('Doubao page load timeout')
        }),
      ])
    } catch (error) {
      console.warn('[Doubao] Page load did not fully finish, continuing with current browser context:', error)
      if (win.webContents.getURL().startsWith('chrome-error://')) {
        throw new Error(`Doubao page load failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
      if (win.webContents.getURL() === '') {
        await win.loadURL(DOUBAO_WEB_BASE)
      }
    }
  }

  private async waitForDoubaoFetchHook(win: BrowserWindow): Promise<{
    hooked: boolean
    fetchHook: string
    pageUrl: string
  }> {
    const startedAt = Date.now()
    let lastState = {
      hooked: false,
      fetchHook: '',
      pageUrl: win.webContents.getURL(),
    }

    while (Date.now() - startedAt < 10000) {
      try {
        lastState = await win.webContents.executeJavaScript(`
          (() => {
            const fetchHook = String(window.fetch).substring(0, 160)
            return {
              hooked: !/native code/i.test(fetchHook),
              fetchHook,
              pageUrl: location.href
            }
          })()
        `, true)
        if (lastState.hooked) {
          return lastState
        }
      } catch (error) {
        console.warn('[Doubao] Failed checking fetch hook:', error)
      }

      await delay(500)
    }

    return lastState
  }
}

export const doubaoAdapter = {
  DoubaoAdapter,
}
