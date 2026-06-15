/**
 * Doubao Authentication Adapter
 * Authentication method: manual sessionid cookie.
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

const DOUBAO_WEB_BASE = 'https://www.doubao.com'

export class DoubaoAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'doubao',
      authMethods: ['manual', 'cookie'],
      loginUrl: DOUBAO_WEB_BASE,
      apiUrl: DOUBAO_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'doubao',
      error: 'Please log in to doubao.com in your browser and enter the sessionid cookie manually',
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // No callback processing needed for cookie-based auth.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const sessionid = credentials.sessionid || credentials.sessionId || extractCookieValue(credentials.cookie, 'sessionid')
    if (!sessionid) {
      return {
        valid: false,
        error: 'Missing required credential: sessionid',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        userId: sessionid.slice(0, 8),
        name: 'Doubao User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const sessionid = credentials.sessionid || credentials.sessionId || extractCookieValue(credentials.cookie, 'sessionid')
    if (!sessionid) {
      return null
    }

    return {
      type: 'cookie',
      value: sessionid,
      extra: {
        sessionid,
        ...(credentials.cookie ? { cookie: credentials.cookie } : {}),
      },
    }
  }
}

function extractCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return ''
  const pair = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return pair ? pair.slice(name.length + 1) : ''
}

export default DoubaoAdapter
