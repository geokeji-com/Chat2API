/**
 * Yuanbao Authentication Adapter
 * Authentication method: browser Cookie and optional learned request headers.
 */

import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const YUANBAO_WEB_BASE = 'https://yuanbao.tencent.com'

export class YuanbaoAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'yuanbao',
      authMethods: ['manual', 'cookie'],
      loginUrl: `${YUANBAO_WEB_BASE}/chat/naQivTmsDa`,
      apiUrl: YUANBAO_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'yuanbao',
      error: 'Please log in to yuanbao.tencent.com in your browser and paste the request Cookie manually',
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // No callback processing needed for cookie-based auth.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const cookie = normalizeCookie(credentials.cookie || credentials.cookies)
    const hyUser = credentials.hy_user || extractCookieValue(cookie, 'hy_user')
    const hyToken = credentials.hy_token || extractCookieValue(cookie, 'hy_token')
    const xUskey = credentials.x_uskey || credentials.xUskey || credentials['x-uskey']

    if (!cookie && !hyUser && !hyToken && !xUskey) {
      return {
        valid: false,
        error: 'Missing Yuanbao credentials: paste Cookie or learned x-uskey/header values',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        userId: hyUser || hyToken?.slice(0, 12) || xUskey?.slice(0, 12),
        name: 'Yuanbao User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const cookie = normalizeCookie(credentials.cookie || credentials.cookies)
    if (!cookie && !credentials.hy_token && !credentials.x_uskey && !credentials['x-uskey']) {
      return null
    }

    return {
      type: 'cookie',
      value: cookie || credentials.hy_token || credentials.x_uskey || credentials['x-uskey'],
      extra: {
        ...(cookie ? { cookie } : {}),
        ...(credentials.hy_user ? { hy_user: credentials.hy_user } : {}),
        ...(credentials.hy_token ? { hy_token: credentials.hy_token } : {}),
        ...(credentials.x_uskey ? { x_uskey: credentials.x_uskey } : {}),
        ...(credentials['x-uskey'] ? { x_uskey: credentials['x-uskey'] } : {}),
      },
    }
  }
}

function normalizeCookie(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return ''

  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] =>
      typeof entry[0] === 'string'
      && typeof entry[1] === 'string'
      && entry[0].length > 0
      && entry[1].length > 0
    )
    .map(([key, cookieValue]) => `${key}=${cookieValue}`)
    .join('; ')
}

function extractCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return ''
  const pair = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return pair ? pair.slice(name.length + 1) : ''
}

export default YuanbaoAdapter
