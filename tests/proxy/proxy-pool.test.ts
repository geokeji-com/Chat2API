import test from 'node:test'
import assert from 'node:assert/strict'

import type { Account, ProxyNode } from '../../src/main/store/types.ts'
import {
  isProxyNodeAssignable,
  isProxyNodeUsedByProvider,
  normalizeProxyMode,
  selectProxyNodeForAccount,
} from '../../src/main/proxy/proxyPoolRules.ts'
import {
  applyAxiosProxyConfig,
  buildSocksProxyUrl,
  isLikelyProxyTransportError,
} from '../../src/main/proxy/proxyTransport.ts'

function node(id: string, overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    id,
    name: id,
    host: `${id}.example.test`,
    port: 1080,
    enabled: true,
    status: 'active',
    failureCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function account(id: string, providerId: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    providerId,
    name: id,
    credentials: {},
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    proxyMode: 'none',
    ...overrides,
  }
}

test('proxy mode defaults to direct unless explicitly set to auto', () => {
  assert.equal(normalizeProxyMode(undefined), 'none')
  assert.equal(normalizeProxyMode('none'), 'none')
  assert.equal(normalizeProxyMode('auto'), 'auto')
})

test('same provider cannot reuse a bound proxy node for another active auto account', () => {
  const nodes = [node('p1'), node('p2')]
  const accounts = [
    account('a1', 'deepseek', { proxyMode: 'auto', proxyBinding: { proxyId: 'p1' } }),
    account('a2', 'deepseek', { proxyMode: 'auto' }),
  ]

  assert.equal(isProxyNodeUsedByProvider(accounts, 'p1', 'deepseek', 'a2'), true)
  assert.equal(selectProxyNodeForAccount(nodes, accounts, 'deepseek', 'a2')?.id, 'p2')
})

test('different providers can reuse the same proxy node', () => {
  const nodes = [node('p1')]
  const accounts = [
    account('a1', 'deepseek', { proxyMode: 'auto', proxyBinding: { proxyId: 'p1' } }),
    account('a2', 'glm', { proxyMode: 'auto' }),
  ]

  assert.equal(isProxyNodeUsedByProvider(accounts, 'p1', 'glm', 'a2'), false)
  assert.equal(selectProxyNodeForAccount(nodes, accounts, 'glm', 'a2')?.id, 'p1')
})

test('inactive, error, disabled, and cooling nodes are skipped for new assignment', () => {
  const now = 1000
  const nodes = [
    node('disabled', { enabled: false }),
    node('inactive', { status: 'inactive' }),
    node('error', { status: 'error' }),
    node('cooling', { status: 'cooldown', cooldownUntil: now + 1000 }),
    node('expiredCooldown', { status: 'cooldown', cooldownUntil: now - 1 }),
    node('active', { failureCount: 1 }),
  ]

  assert.equal(isProxyNodeAssignable(nodes[0], now), false)
  assert.equal(isProxyNodeAssignable(nodes[1], now), false)
  assert.equal(isProxyNodeAssignable(nodes[2], now), false)
  assert.equal(isProxyNodeAssignable(nodes[3], now), false)
  assert.equal(isProxyNodeAssignable(nodes[4], now), true)
  assert.equal(selectProxyNodeForAccount(nodes, [], 'deepseek', 'a1', undefined, now)?.id, 'expiredCooldown')
})

test('axios SOCKS5 proxy config injects agents and disables axios env proxy handling', () => {
  const proxyNode = node('encoded', {
    host: '127.0.0.1',
    port: 1086,
    username: 'user name',
    password: 'p@ss:word',
  })
  const url = buildSocksProxyUrl(proxyNode)
  const config = applyAxiosProxyConfig({ timeout: 1000 }, { node: proxyNode, url })

  assert.equal(url, 'socks5://user%20name:p%40ss%3Aword@127.0.0.1:1086')
  assert.equal(config.timeout, 1000)
  assert.equal(config.proxy, false)
  assert.ok(config.httpAgent)
  assert.equal(config.httpAgent, config.httpsAgent)
})

test('provider HTTP responses are not classified as proxy transport failures', () => {
  assert.equal(isLikelyProxyTransportError({ response: { status: 429 }, message: 'rate limited' }), false)
  assert.equal(isLikelyProxyTransportError({ code: 'ECONNRESET', message: 'socket hang up' }), true)
})
