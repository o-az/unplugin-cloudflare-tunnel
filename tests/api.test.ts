import { describe, expect, it } from 'vitest'

import { getLocalTarget, normalizeAddress } from '../src/api.ts'

describe('api utilities', () => {
  it('normalizes wildcard server hosts to localhost', () => {
    expect(normalizeAddress({ address: '0.0.0.0', port: 5173 })).toEqual({
      host: 'localhost',
      port: 5173
    })
    expect(normalizeAddress({ address: '::', port: 8811 })).toEqual({
      host: 'localhost',
      port: 8811
    })
  })

  it('preserves explicit hostnames and ports', () => {
    expect(normalizeAddress({ address: '127.0.0.1', port: 3000 })).toEqual({
      host: '127.0.0.1',
      port: 3000
    })
    expect(normalizeAddress({ address: 'dev.local', port: 3001 })).toEqual({
      host: 'dev.local',
      port: 3001
    })
  })

  it('formats ipv4 and ipv6 local targets correctly', () => {
    expect(getLocalTarget('localhost', 6420)).toBe('http://localhost:6420')
    expect(getLocalTarget('::1', 6420)).toBe('http://[::1]:6420')
  })
})
