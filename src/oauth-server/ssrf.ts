import { isIP } from 'node:net';

/**
 * Address filtering for the one outbound fetch Bifrost makes to a URL somebody
 * else chose: the Client ID Metadata Document.
 *
 * Without this, `client_id=https://internal.host/x` would make the server fetch
 * an address only it can reach and report back on what it found — the classic
 * SSRF shape, and on a cloud host `169.254.169.254` is a credential endpoint.
 */

const IPV6_HEXTETS = 8;

/** Blocked because reaching one of these means the request never left our own network. */
const BLOCKED_IPV4_RANGES: readonly { prefix: number; bits: number }[] = [
  { prefix: 0x00000000, bits: 8 },   // 0.0.0.0/8, "this network"
  { prefix: 0x0a000000, bits: 8 },   // 10.0.0.0/8, private
  { prefix: 0x64400000, bits: 10 },  // 100.64.0.0/10, carrier-grade NAT
  { prefix: 0x7f000000, bits: 8 },   // 127.0.0.0/8, loopback
  { prefix: 0xa9fe0000, bits: 16 },  // 169.254.0.0/16, link-local and cloud metadata
  { prefix: 0xac100000, bits: 12 },  // 172.16.0.0/12, private
  { prefix: 0xc0000000, bits: 24 },  // 192.0.0.0/24, IETF protocol assignments
  { prefix: 0xc0a80000, bits: 16 },  // 192.168.0.0/16, private
  { prefix: 0xc6120000, bits: 15 },  // 198.18.0.0/15, benchmarking
  { prefix: 0xe0000000, bits: 4 },   // 224.0.0.0/4, multicast
  { prefix: 0xf0000000, bits: 4 },   // 240.0.0.0/4, reserved
];

/**
 * Whether an address is on the public internet.
 *
 * Fails closed: anything unparseable is treated as not routable, because an
 * address this function cannot reason about is not one it can vouch for.
 */
export function isPubliclyRoutableAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const value = octets.reduce((accumulated, octet) => ((accumulated << 8) | octet) >>> 0, 0);
  return !BLOCKED_IPV4_RANGES.some(({ prefix, bits }) => (value >>> (32 - bits)) === (prefix >>> (32 - bits)));
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // An IPv4-mapped address (::ffff:127.0.0.1) reaches an IPv4 destination, so
  // the IPv4 rules are the ones that decide it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPublicIpv4(mapped[1]);

  const hextets = expandIpv6(normalized);
  if (!hextets) return false;
  if (hextets.every((hextet) => hextet === 0)) return false;                       // ::, unspecified
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) return false; // ::1, loopback
  const leadingByte = (hextets[0] ?? 0) >> 8;
  if (leadingByte === 0xff) return false;                        // ff00::/8, multicast
  if ((leadingByte & 0xfe) === 0xfc) return false;               // fc00::/7, unique local
  if (leadingByte === 0xfe && ((hextets[0] ?? 0) >> 6 & 0b11) === 0b10) return false; // fe80::/10, link-local
  return true;
}

function expandIpv6(address: string): number[] | undefined {
  const parts = address.split('::');
  if (parts.length > 2) return undefined;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = IPV6_HEXTETS - head.length - tail.length;
  if (parts.length === 1 && head.length !== IPV6_HEXTETS) return undefined;
  if (parts.length === 2 && missing < 0) return undefined;
  const groups = [...head, ...Array<string>(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  const hextets = groups.map((group) => Number.parseInt(group || '0', 16));
  if (hextets.length !== IPV6_HEXTETS || hextets.some((hextet) => !Number.isInteger(hextet) || hextet < 0 || hextet > 0xffff)) return undefined;
  return hextets;
}
