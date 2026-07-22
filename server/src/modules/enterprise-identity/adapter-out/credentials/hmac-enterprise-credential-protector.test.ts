import { expect, test } from 'bun:test'
import type {
  EnterpriseOneTimeCredentialInput,
} from '../../application/ports/enterprise-credential-protector'
import { HmacEnterpriseCredentialProtector } from './hmac-enterprise-credential-protector'

const secret = '0123456789abcdef0123456789abcdef'

test('binds credential digests to kind, workspace, and credential ID', () => {
  const protector = new HmacEnterpriseCredentialProtector(secret)
  const digest = protector.digest({
    kind: 'scim',
    workspaceId: 'workspace-1',
    credentialId: 'credential-1',
    token: 'msc_token',
  })

  expect(protector.matchesDigest(digest, digest)).toBe(true)
  expect(protector.matchesDigest(
    digest,
    protector.digest({
      kind: 'scim',
      workspaceId: 'workspace-2',
      credentialId: 'credential-1',
      token: 'msc_token',
    }),
  )).toBe(false)
  expect(protector.matchesDigest('malformed', digest)).toBe(false)
})

test('derives stable retry credentials without exposing the HMAC secret', () => {
  const protector = new HmacEnterpriseCredentialProtector(secret)
  const input = {
    kind: 'service-account',
    workspaceId: 'workspace-1',
    entityId: 'account-1',
    generation: 2,
    receiptKey: 'receipt-1',
  } satisfies EnterpriseOneTimeCredentialInput

  const first = protector.deriveOneTimeToken(input)
  expect(first).toBe(protector.deriveOneTimeToken(input))
  expect(first.startsWith('msa_')).toBe(true)
  expect(first.includes(secret)).toBe(false)
  expect(protector.createRandomToken('scim').startsWith('msc_')).toBe(true)
})
