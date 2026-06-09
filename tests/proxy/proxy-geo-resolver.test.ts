import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCz88GeoResponse,
  resolveProxyGeoByHost,
} from '../../src/main/proxy/proxyGeoResolver.ts'

test('parses cz88 province city and city code', () => {
  const geo = parseCz88GeoResponse({
    code: 200,
    success: true,
    data: {
      province: '安徽',
      city: '合肥',
      provinceCode: '340000',
      cityCode: '340100',
      districtCode: '未知',
    },
  })

  assert.deepEqual(geo, {
    province: '安徽',
    city: '合肥',
    regionCode: 'ZH-340100',
  })
})

test('resolves proxy geo through cz88 endpoint', async () => {
  const requestedUrls: string[] = []
  const fetchMock = async (url: string | URL | Request) => {
    requestedUrls.push(String(url))
    return {
      ok: true,
      json: async () => ({
        code: 200,
        success: true,
        data: {
          province: '陕西',
          city: '西安',
          cityCode: '610100',
        },
      }),
    } as Response
  }

  const geo = await resolveProxyGeoByHost('223.244.21.68', 1000, fetchMock as typeof fetch)

  assert.deepEqual(geo, {
    province: '陕西',
    city: '西安',
    regionCode: 'ZH-610100',
  })
  assert.equal(requestedUrls[0].includes('cz88.net/api/cz88/ip/base'), true)
  assert.equal(requestedUrls[0].includes('ip=223.244.21.68'), true)
})
