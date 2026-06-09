import test from 'node:test'
import assert from 'node:assert/strict'

import { parseProxyImportText } from '../../src/shared/proxyImport.ts'

test('parses SOCKS5 URLs with encoded credentials and names', () => {
  const result = parseProxyImportText('socks5://user%20a:p%40ss@127.0.0.1:1086#local')

  assert.equal(result.nodes.length, 1)
  assert.equal(result.issues.length, 0)
  assert.deepEqual(result.nodes[0], {
    name: 'local',
    host: '127.0.0.1',
    port: 1086,
    username: 'user a',
    password: 'p@ss',
    enabled: true,
    sourceLine: 1,
  })
})

test('parses colon and userinfo formats without leaking passwords in issues', () => {
  const result = parseProxyImportText([
    'proxy.example.com:1080:alice:secret:with:colon',
    'bob:pwd@proxy-2.example.com:2080',
    'not-a-proxy secret-password',
  ].join('\n'))

  assert.equal(result.nodes.length, 2)
  assert.equal(result.nodes[0].password, 'secret:with:colon')
  assert.equal(result.nodes[1].username, 'bob')
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].input.includes('secret-password'), false)
})

test('parses key value and table formats by detecting field names', () => {
  const keyValue = parseProxyImportText('host=10.0.0.1 port=1080 username=tom password=pwd name=edge-a province=陕西 city=西安 region_code=610100')
  assert.equal(keyValue.nodes[0].name, 'edge-a')
  assert.equal(keyValue.nodes[0].host, '10.0.0.1')
  assert.equal(keyValue.nodes[0].username, 'tom')
  assert.equal(keyValue.nodes[0].province, '陕西')
  assert.equal(keyValue.nodes[0].city, '西安')
  assert.equal(keyValue.nodes[0].regionCode, 'ZH-610100')

  const table = parseProxyImportText([
    'name,host,port,username,password,province,city,city_code',
    'edge-b,10.0.0.2,1081,jerry,pwd2,陕西,西安,610100',
  ].join('\n'))
  assert.equal(table.nodes.length, 1)
  assert.equal(table.issues.length, 0)
  assert.equal(table.nodes[0].name, 'edge-b')
  assert.equal(table.nodes[0].password, 'pwd2')
  assert.equal(table.nodes[0].regionCode, 'ZH-610100')
})

test('deduplicates repeated nodes in the same import text', () => {
  const result = parseProxyImportText([
    '10.0.0.1:1080:user:pwd',
    '10.0.0.1:1080:user:pwd',
  ].join('\n'))

  assert.equal(result.nodes.length, 1)
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].code, 'duplicate')
})

test('parses whitespace rows and reports empty input', () => {
  const result = parseProxyImportText('edge c proxy.example.com 1080 user pass')
  assert.equal(result.nodes.length, 1)
  assert.equal(result.nodes[0].name, 'edge c')
  assert.equal(result.nodes[0].host, 'proxy.example.com')

  const empty = parseProxyImportText('   \n')
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.issues[0].code, 'empty')
})

test('infers host port and credentials from flexible column order', () => {
  const result = parseProxyImportText([
    'alice secret proxy-a.example.com 1080',
    'proxy-b.example.com bob secret 2080',
    'team-a,charlie,secret,proxy-c.example.com,3080',
    'dave:secret:proxy-d.example.com:4080',
  ].join('\n'))

  assert.equal(result.nodes.length, 4)
  assert.equal(result.issues.length, 0)
  assert.deepEqual(
    result.nodes.map(node => ({
      name: node.name,
      host: node.host,
      port: node.port,
      username: node.username,
      password: node.password,
    })),
    [
      {
        name: 'proxy-a.example.com:1080',
        host: 'proxy-a.example.com',
        port: 1080,
        username: 'alice',
        password: 'secret',
      },
      {
        name: 'proxy-b.example.com:2080',
        host: 'proxy-b.example.com',
        port: 2080,
        username: 'bob',
        password: 'secret',
      },
      {
        name: 'team-a',
        host: 'proxy-c.example.com',
        port: 3080,
        username: 'charlie',
        password: 'secret',
      },
      {
        name: 'proxy-d.example.com:4080',
        host: 'proxy-d.example.com',
        port: 4080,
        username: 'dave',
        password: 'secret',
      },
    ]
  )
})
