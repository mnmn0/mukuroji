import { BlockList, isIP } from 'node:net'

/** Automation webhook signing secret の alias 形式です。 */
export const AUTOMATION_WEBHOOK_SECRET_ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

const blockedIpv4Addresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4')
}

const globalIpv6Addresses = new BlockList()
globalIpv6Addresses.addSubnet('2000::', 3, 'ipv6')

const blockedIpv6Addresses = new BlockList()
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6')
}

/** Secret reference が workspace 内 alias として安全か返します。 */
export function isAutomationWebhookSecretAlias(value: unknown): value is string {
  return typeof value === 'string' && AUTOMATION_WEBHOOK_SECRET_ALIAS_PATTERN.test(value)
}

/** URL を安全な outbound HTTPS endpoint として検証します。 */
export function readAutomationWebhookEndpoint(value: string) {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return undefined
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.port && endpoint.port !== '443')
  ) {
    return undefined
  }
  const hostname = normalizeAutomationWebhookHostname(endpoint.hostname)
  if (!hostname || isReservedAutomationWebhookHostname(hostname)) return undefined
  const addressFamily = isIP(hostname)
  if (addressFamily > 0 && !isPublicAutomationWebhookAddress(hostname)) return undefined
  return endpoint
}

/** IPv4/IPv6 address が public internet へ routing 可能か返します。 */
export function isPublicAutomationWebhookAddress(address: string) {
  const normalized = normalizeAutomationWebhookHostname(address)
  const addressFamily = isIP(normalized)
  if (addressFamily === 4) return !blockedIpv4Addresses.check(normalized, 'ipv4')
  if (addressFamily !== 6) return false
  return globalIpv6Addresses.check(normalized, 'ipv6') &&
    !blockedIpv6Addresses.check(normalized, 'ipv6')
}

/** URL hostname や IP literal を比較可能な形式へ正規化します。 */
export function normalizeAutomationWebhookHostname(value: string) {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return unwrapped.toLowerCase().replace(/\.$/, '')
}

function isReservedAutomationWebhookHostname(hostname: string) {
  if (isIP(hostname) > 0) return false
  return !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
}
