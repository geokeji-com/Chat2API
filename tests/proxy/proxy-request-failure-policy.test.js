const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

function readSource(path) {
  return readFileSync(join(root, path), 'utf8')
}

function extractMethod(source, methodName) {
  const signatureIndex = source.indexOf(`${methodName}(`)
  assert.notEqual(signatureIndex, -1, `${methodName} should exist`)

  const bodyStart = source.indexOf('{', signatureIndex)
  assert.notEqual(bodyStart, -1, `${methodName} should have a body`)

  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      return source.slice(bodyStart, index + 1)
    }
  }

  assert.fail(`${methodName} body should be balanced`)
}

test('chat request failures never mark proxy nodes failed', () => {
  const forwarder = readSource('src/main/proxy/forwarder.ts')
  const chatRoute = readSource('src/main/proxy/routes/chat.ts')

  assert.doesNotMatch(forwarder, /markNodeFailed\(/)
  assert.doesNotMatch(chatRoute, /markNodeFailed\(/)
  assert.doesNotMatch(chatRoute, /proxyPoolManager/)
})

test('proxy failure handling keeps the current account binding', () => {
  const proxyPool = readSource('src/main/proxy/proxyPool.ts')
  const handleFailure = extractMethod(proxyPool, 'handleProxyFailure')

  assert.match(handleFailure, /keeping current proxy binding/)
  assert.match(handleFailure, /switched:\s*false/)
  assert.doesNotMatch(handleFailure, /markNodeFailed\(/)
  assert.doesNotMatch(handleFailure, /selectAvailableNode\(/)
  assert.doesNotMatch(handleFailure, /bindAccount\(/)
})
