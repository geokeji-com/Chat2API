import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_ROUTE_HEADER_NAMES,
  attachAccountRouteInfo,
  attachProxyRouteInfo,
  buildAccountRouteInfo,
  buildProxyRouteInfo,
  CHAT2API_ROUTE_HEADER_NAMES,
  PROXY_ROUTE_HEADER_NAMES,
  setAccountRouteHeaders,
  setProxyRouteHeaders,
} from '../../src/main/proxy/proxyRouteInfo.ts'

test('buildProxyRouteInfo exposes proxy host and port without credentials', () => {
  const proxy = buildProxyRouteInfo({
    proxyId: 'proxy-1',
    proxyName: 'Hangzhou SOCKS',
    proxyHost: '203.0.113.10',
    proxyPort: 1080,
  })

  assert.deepEqual(proxy, {
    mode: 'proxy',
    id: 'proxy-1',
    name: 'Hangzhou SOCKS',
    host: '203.0.113.10',
    port: 1080,
    address: '203.0.113.10:1080',
  })
  assert.equal('username' in proxy, false)
  assert.equal('password' in proxy, false)
})

test('buildProxyRouteInfo marks direct requests when no proxy host or port is present', () => {
  assert.deepEqual(buildProxyRouteInfo({}), { mode: 'direct' })
  assert.deepEqual(buildProxyRouteInfo({ proxyHost: '203.0.113.10' }), { mode: 'direct' })
})

test('setProxyRouteHeaders writes stable Python-readable response headers', () => {
  const headers: Record<string, string> = {}
  setProxyRouteHeaders(
    { set: (name, value) => { headers[name] = value } },
    buildProxyRouteInfo({
      proxyId: 'proxy-1',
      proxyName: 'Hangzhou SOCKS',
      proxyHost: '203.0.113.10',
      proxyPort: 1080,
    }),
  )

  assert.deepEqual(PROXY_ROUTE_HEADER_NAMES, [
    'X-Chat2API-Proxy-Mode',
    'X-Chat2API-Proxy-Id',
    'X-Chat2API-Proxy-Name',
    'X-Chat2API-Proxy-Host',
    'X-Chat2API-Proxy-Port',
    'X-Chat2API-Proxy-Address',
  ])
  assert.equal(headers['X-Chat2API-Proxy-Mode'], 'proxy')
  assert.equal(headers['X-Chat2API-Proxy-Host'], '203.0.113.10')
  assert.equal(headers['X-Chat2API-Proxy-Port'], '1080')
  assert.equal(headers['X-Chat2API-Proxy-Address'], '203.0.113.10:1080')
})

test('account route info exposes account identity without credentials', () => {
  const account = buildAccountRouteInfo(
    {
      id: 'account-1',
      name: '采集账号 A',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
    },
  )

  assert.deepEqual(account, {
    id: 'account-1',
    name: '采集账号 A',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
  })
  assert.equal('credentials' in account, false)
})

test('setAccountRouteHeaders writes stable Python-readable response headers', () => {
  const headers: Record<string, string> = {}
  setAccountRouteHeaders(
    { set: (name, value) => { headers[name] = value } },
    buildAccountRouteInfo(
      { id: 'account-1', name: '采集账号 A' },
      { id: 'deepseek', name: 'DeepSeek' },
    ),
  )

  assert.deepEqual(ACCOUNT_ROUTE_HEADER_NAMES, [
    'X-Chat2API-Account-Id',
    'X-Chat2API-Account-Name',
    'X-Chat2API-Provider-Id',
    'X-Chat2API-Provider-Name',
  ])
  assert.deepEqual(CHAT2API_ROUTE_HEADER_NAMES, [
    ...PROXY_ROUTE_HEADER_NAMES,
    ...ACCOUNT_ROUTE_HEADER_NAMES,
  ])
  assert.equal(headers['X-Chat2API-Account-Id'], 'account-1')
  assert.equal(headers['X-Chat2API-Account-Name'], encodeURIComponent('采集账号 A'))
  assert.equal(headers['X-Chat2API-Provider-Id'], 'deepseek')
  assert.equal(headers['X-Chat2API-Provider-Name'], 'DeepSeek')
})

test('attachProxyRouteInfo preserves existing chat2api metadata', () => {
  const body = attachProxyRouteInfo(
    {
      id: 'chatcmpl-1',
      chat2api: {
        provider: 'deepseek',
        share_url: 'https://example.test/share',
      },
    },
    buildProxyRouteInfo({
      proxyId: 'proxy-1',
      proxyHost: '203.0.113.10',
      proxyPort: 1080,
    }),
  )

  assert.equal(body.chat2api.provider, 'deepseek')
  assert.equal(body.chat2api.share_url, 'https://example.test/share')
  assert.deepEqual(body.chat2api.proxy, {
    mode: 'proxy',
    id: 'proxy-1',
    name: undefined,
    host: '203.0.113.10',
    port: 1080,
    address: '203.0.113.10:1080',
  })
})

test('attachAccountRouteInfo preserves existing chat2api metadata', () => {
  const body = attachAccountRouteInfo(
    {
      id: 'chatcmpl-1',
      chat2api: {
        proxy: { mode: 'direct' },
      },
    },
    buildAccountRouteInfo(
      { id: 'account-1', name: '采集账号 A' },
      { id: 'deepseek', name: 'DeepSeek' },
    ),
  )

  assert.deepEqual(body.chat2api.proxy, { mode: 'direct' })
  assert.deepEqual(body.chat2api.account, {
    id: 'account-1',
    name: '采集账号 A',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
  })
})
