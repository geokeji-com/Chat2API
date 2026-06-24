const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

function readSource(path) {
  return readFileSync(join(root, path), 'utf8')
}

function extractMethod(source, signature) {
  const signatureIndex = source.indexOf(signature)
  assert.notEqual(signatureIndex, -1, `${signature} should exist`)

  const bodyStart = source.indexOf('{', signatureIndex)
  assert.notEqual(bodyStart, -1, `${signature} should have a body`)

  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      return source.slice(bodyStart, index + 1)
    }
  }

  assert.fail(`${signature} body should be balanced`)
}

test('electron-store encryption key is stable when safeStorage is unavailable', () => {
  const storeSource = readSource('src/main/store/store.ts')
  const getEncryptionKey = extractMethod(storeSource, 'private getEncryptionKey(')

  assert.match(getEncryptionKey, /chat2api-fixed-encryption-key-v1/)
  assert.doesNotMatch(getEncryptionKey, /safeStorage\.isEncryptionAvailable/)
  assert.doesNotMatch(getEncryptionKey, /return\s+undefined/)
})
