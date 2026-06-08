import { describe, it, expect } from 'vitest'
import {
  isPrivateOrLoopbackV4,
  isPrivateOrLoopbackV6,
} from '../../../supabase/functions/_shared/ssrf'

describe('isPrivateOrLoopbackV4', () => {
  it('bloqueia o metadata da cloud e loopback/private/link-local', () => {
    for (const ip of [
      '169.254.169.254', // metadata (AWS/GCP)
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrLoopbackV4(ip), ip).toBe(true)
    }
  })

  it('libera IPs públicos', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '11.0.0.1', '93.184.216.34']) {
      expect(isPrivateOrLoopbackV4(ip), ip).toBe(false)
    }
  })

  it('trata entrada inválida como insegura (true)', () => {
    expect(isPrivateOrLoopbackV4('999.1.1.1')).toBe(true)
    expect(isPrivateOrLoopbackV4('nope')).toBe(true)
  })
})

describe('isPrivateOrLoopbackV6', () => {
  it('bloqueia loopback, link-local, ULA e IPv4-mapeado interno', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect(isPrivateOrLoopbackV6(ip), ip).toBe(true)
    }
  })

  it('libera IPv6 público (ex.: Cloudflare/Google DNS)', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPrivateOrLoopbackV6(ip), ip).toBe(false)
    }
  })
})
