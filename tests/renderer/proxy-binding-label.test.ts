import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { Account, ProxyNode } from '../../src/shared/types.ts'
import {
  formatAccountProxyBinding,
  formatProxyNodeLabel,
} from '../../src/renderer/src/lib/proxyBinding.ts'

const labels = {
  direct: 'No proxy',
  pending: 'Pending assignment',
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    providerId: 'deepseek',
    name: 'Account 1',
    credentials: {},
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function proxyNode(overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    id: '1740000000000-abcdefghi',
    name: 'Shanghai Node',
    host: '127.0.0.1',
    port: 1080,
    enabled: true,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

test('proxy binding label resolves node name from the actual bound proxy id', () => {
  const node = proxyNode()
  const boundAccount = account({
    proxyMode: 'auto',
    proxyBinding: { proxyId: node.id, assignedAt: 1 },
  })

  assert.equal(
    formatAccountProxyBinding(boundAccount, [node], labels),
    formatProxyNodeLabel(node),
  )
})

test('proxy binding label handles direct and pending accounts', () => {
  assert.equal(formatAccountProxyBinding(account({ proxyMode: 'none' }), [], labels), 'No proxy')
  assert.equal(formatAccountProxyBinding(account({ proxyMode: 'auto' }), [], labels), 'Pending assignment')
})

test('proxy binding label falls back to full id when the node no longer exists', () => {
  const boundAccount = account({
    proxyMode: 'auto',
    proxyBinding: { proxyId: 'missing-proxy-id' },
  })

  assert.equal(formatAccountProxyBinding(boundAccount, [], labels), 'missing-proxy-id')
})

test('account list and detail share the same proxy binding formatter', () => {
  const accountList = readFileSync('src/renderer/src/components/providers/AccountList.tsx', 'utf8')
  const accountDetail = readFileSync('src/renderer/src/components/providers/AccountDetail.tsx', 'utf8')

  for (const source of [accountList, accountDetail]) {
    assert.match(source, /formatAccountProxyBinding/)
    assert.doesNotMatch(source, /proxyBinding\?\.proxyId\?\.slice/)
    assert.doesNotMatch(source, /account\.proxyBinding\?\.proxyId \|\|/)
  }
})
