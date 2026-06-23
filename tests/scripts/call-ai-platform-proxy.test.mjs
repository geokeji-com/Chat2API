import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT_PATH = new URL('../../scripts/call_ai_platform.py', import.meta.url)

function runPythonHarness(source) {
  const dir = mkdtempSync(join(tmpdir(), 'chat2api-python-proxy-'))
  const harnessPath = join(dir, 'harness.py')
  writeFileSync(harnessPath, source)
  const output = execFileSync('python3', [harnessPath, SCRIPT_PATH.pathname], {
    encoding: 'utf8',
  })
  return JSON.parse(output)
}

test('call_ai_platform extracts standard proxy info from non-stream response body', () => {
  const result = runPythonHarness(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("call_ai_platform", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

response = {
    "chat2api": {
        "proxy": {
            "mode": "proxy",
            "id": "proxy-1",
            "name": "secret-free name",
            "host": "203.0.113.10",
            "port": 1080,
            "address": "203.0.113.10:1080",
        }
    }
}
print(json.dumps(module.extract_proxy_info(response)))
`)

  assert.deepEqual(result, {
    ip: '203.0.113.10',
    port: 1080,
    address: '203.0.113.10:1080',
  })
})

test('call_ai_platform extracts standard proxy info from stream response headers', () => {
  const result = runPythonHarness(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("call_ai_platform", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

route = module.extract_proxy_route_from_headers({
    "X-Chat2API-Proxy-Mode": "proxy",
    "X-Chat2API-Proxy-Host": "198.51.100.24",
    "X-Chat2API-Proxy-Port": "18080",
    "X-Chat2API-Proxy-Address": "198.51.100.24:18080",
})
print(json.dumps(module.extract_proxy_info({module.INTERNAL_PROXY_ROUTE_KEY: route})))
`)

  assert.deepEqual(result, {
    ip: '198.51.100.24',
    port: 18080,
    address: '198.51.100.24:18080',
  })
})

test('call_ai_platform rejects direct or missing proxy metadata', () => {
  const result = runPythonHarness(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("call_ai_platform", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

print(json.dumps({
    "direct": module.extract_proxy_info({"chat2api": {"proxy": {"mode": "direct"}}}),
    "missing": module.extract_proxy_info({}),
}))
`)

  assert.deepEqual(result, {
    direct: null,
    missing: null,
  })
})
