import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const skillPaths = [
  { file: 'skills/chat2api-management-api/SKILL.md', name: 'chat2api-management-api' },
  { file: 'skills/chat2api-har-tool-fixture/SKILL.md', name: 'chat2api-har-tool-fixture' },
  { file: 'skills/chat2api-tool-client-replay/SKILL.md', name: 'chat2api-tool-client-replay' },
  { file: 'skills/chat2api-provider-model-matrix/SKILL.md', name: 'chat2api-provider-model-matrix' },
  { file: 'skills/chat2api-proxy-testing/SKILL.md', name: 'chat2api-proxy-testing' },
]

test('versioned Chat2API testing skills exist and have trigger-only descriptions', () => {
  for (const { file, name } of skillPaths) {
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: Use when `, 'm'), file)
    assert.doesNotMatch(text, /T[B]D|FI[X]ME|deferred work/, file)
  }
})

test('proxy testing skill delegates focused responsibilities', () => {
  const text = fs.readFileSync('skills/chat2api-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /chat2api-management-api/)
  assert.match(text, /chat2api-har-tool-fixture/)
  assert.match(text, /chat2api-tool-client-replay/)
  assert.match(text, /chat2api-provider-model-matrix/)
})
