import { describe, expect, it } from 'vitest';
import { isPubliclyRoutableAddress } from '../src/oauth-server/ssrf.js';

describe('outbound address filtering', () => {
  it('allows ordinary public addresses', () => {
    expect(isPubliclyRoutableAddress('93.184.216.34')).toBe(true);
    expect(isPubliclyRoutableAddress('8.8.8.8')).toBe(true);
    expect(isPubliclyRoutableAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });

  it('blocks loopback', () => {
    expect(isPubliclyRoutableAddress('127.0.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('127.1.2.3')).toBe(false);
    expect(isPubliclyRoutableAddress('::1')).toBe(false);
  });

  it('blocks the private ranges', () => {
    expect(isPubliclyRoutableAddress('10.0.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('172.16.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('172.31.255.255')).toBe(false);
    expect(isPubliclyRoutableAddress('192.168.1.1')).toBe(false);
    expect(isPubliclyRoutableAddress('fd00::1')).toBe(false);
    expect(isPubliclyRoutableAddress('fc00::1')).toBe(false);
  });

  it('blocks link-local, which is where cloud credential endpoints live', () => {
    expect(isPubliclyRoutableAddress('169.254.169.254')).toBe(false);
    expect(isPubliclyRoutableAddress('fe80::1')).toBe(false);
  });

  it('blocks the unspecified, multicast and reserved ranges', () => {
    expect(isPubliclyRoutableAddress('0.0.0.0')).toBe(false);
    expect(isPubliclyRoutableAddress('::')).toBe(false);
    expect(isPubliclyRoutableAddress('224.0.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('255.255.255.255')).toBe(false);
    expect(isPubliclyRoutableAddress('ff02::1')).toBe(false);
  });

  it('blocks carrier-grade NAT while allowing the public space just outside it', () => {
    expect(isPubliclyRoutableAddress('100.64.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('100.127.255.255')).toBe(false);
    expect(isPubliclyRoutableAddress('100.128.0.1')).toBe(true);
  });

  it('sees through an IPv4-mapped address to the IPv4 rules', () => {
    // ::ffff:127.0.0.1 reaches loopback, so the v6 spelling must not be a way
    // around the v4 checks.
    expect(isPubliclyRoutableAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPubliclyRoutableAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPubliclyRoutableAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('fails closed on anything it cannot parse', () => {
    expect(isPubliclyRoutableAddress('')).toBe(false);
    expect(isPubliclyRoutableAddress('example.com')).toBe(false);
    expect(isPubliclyRoutableAddress('999.1.1.1')).toBe(false);
  });
});
