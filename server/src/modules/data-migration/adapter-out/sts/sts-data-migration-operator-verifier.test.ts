import { describe, expect, test } from 'bun:test'
import {
  createStsDataMigrationOperatorVerifier,
  DATA_MIGRATION_OPERATOR_PROOF_HEADER,
  DataMigrationOperatorProofError,
} from './sts-data-migration-operator-verifier'

/** Binding used by every request. */
const BINDING = 'a'.repeat(64)

/** A well-formed presigned proof URL. */
const PROOF = 'https://sts.ap-northeast-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15' +
  '&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261120%2Fap-northeast-1%2Fsts%2Faws4_request' +
  '&X-Amz-Date=20261120T120000Z&X-Amz-Expires=300' +
  `&X-Amz-SignedHeaders=host%3B${DATA_MIGRATION_OPERATOR_PROOF_HEADER}&X-Amz-Signature=${'b'.repeat(64)}`

/** Signing time of {@link PROOF} in epoch milliseconds. */
const SIGNED_AT = Date.UTC(2026, 10, 20, 12, 0, 0)

/** Caller ARN STS returns in the fake responses. */
const ARN = 'arn:aws:sts::123456789012:assumed-role/migration-operator/alice'

/**
 * Builds a JSON `GetCallerIdentity` response.
 *
 * @param arn - Caller ARN.
 * @param account - Caller account.
 * @returns The response.
 */
function identityResponse(arn = ARN, account = '123456789012'): Response {
  return new Response(JSON.stringify({
    GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: arn, Account: account, UserId: 'AROAEXAMPLE:alice' } },
  }), { status: 200 })
}

/**
 * Creates a verifier over a recording fake `fetch`.
 *
 * @param respond - Response factory.
 * @param now - Verifier clock; one minute after {@link PROOF} was signed by default.
 * @returns The verifier and the recorded calls.
 */
function createVerifier(
  respond: () => Response | Promise<Response> = () => identityResponse(),
  now: () => number = () => SIGNED_AT + 60_000,
) {
  const calls: { url: string; init: RequestInit }[] = []
  const verify = createStsDataMigrationOperatorVerifier({
    region: 'ap-northeast-1',
    now,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return await respond()
    },
  })
  return { verify, calls }
}

/**
 * Captures the rejection reason of a verification.
 *
 * @param promise - Verification.
 * @returns The reason code.
 */
async function reasonOf(promise: Promise<string>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof DataMigrationOperatorProofError) return error.reason
    throw error
  }
  throw new Error('verification unexpectedly succeeded')
}

describe('createStsDataMigrationOperatorVerifier', () => {
  test('returns the ARN STS reports, sending the expected binding header', async () => {
    const { verify, calls } = createVerifier()
    expect(await verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' })).toBe(ARN)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(new URL(PROOF).toString())
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', [DATA_MIGRATION_OPERATOR_PROOF_HEADER]: BINDING },
    })
  })

  test('never contacts a host other than the regional STS endpoint', async () => {
    const { verify, calls } = createVerifier()
    for (const proof of [
      PROOF.replace('sts.ap-northeast-1.amazonaws.com', 'sts.us-east-1.amazonaws.com'),
      PROOF.replace('sts.ap-northeast-1.amazonaws.com', 'sts.ap-northeast-1.amazonaws.com.evil.example'),
      PROOF.replace('sts.ap-northeast-1.amazonaws.com', 'sts.ap-northeast-1.amazonaws.com:8443'),
      PROOF.replace('https://', 'http://'),
      PROOF.replace('https://', 'https://user@'),
      PROOF.replace('.com/?', '.com/other?'),
      `${PROOF}#fragment`,
    ]) {
      expect(await reasonOf(verify({ proof, binding: BINDING, accountId: '123456789012' }))).toBe('PROOF_TARGET_INVALID')
    }
    expect(await reasonOf(verify({ proof: 'not a url', binding: BINDING, accountId: '123456789012' }))).toBe('PROOF_MALFORMED')
    expect(calls).toEqual([])
  })

  test('requires a GetCallerIdentity call with the binding header signed and a short expiry', async () => {
    const { verify, calls } = createVerifier()
    for (const proof of [
      PROOF.replace('Action=GetCallerIdentity', 'Action=AssumeRole'),
      PROOF.replace(`host%3B${DATA_MIGRATION_OPERATOR_PROOF_HEADER}`, 'host'),
      PROOF.replace('X-Amz-Expires=300', 'X-Amz-Expires=3600'),
      PROOF.replace('&X-Amz-Signature=', '&X-Amz-Signature=x&X-Amz-Signature='),
      `${PROOF}&RoleArn=arn`,
      PROOF.replace('&X-Amz-Date=20261120T120000Z', ''),
      PROOF.replace('X-Amz-Date=20261120T120000Z', 'X-Amz-Date=2026-11-20T12:00:00Z'),
      PROOF.replace('X-Amz-Date=20261120T120000Z', 'X-Amz-Date=20261131T120000Z'),
    ]) {
      expect(await reasonOf(verify({ proof, binding: BINDING, accountId: '123456789012' }))).toBe('PROOF_PARAMETERS_INVALID')
    }
    expect(calls).toEqual([])
  })

  test('enforces the declared expiry from the signing time, since STS accepts the URL for 15 minutes', async () => {
    const request = { proof: PROOF, binding: BINDING, accountId: '123456789012' }
    const atExpiry = createVerifier(undefined, () => SIGNED_AT + 300_000)
    expect(await atExpiry.verify(request)).toBe(ARN)
    const expired = createVerifier(undefined, () => SIGNED_AT + 300_001)
    expect(await reasonOf(expired.verify(request))).toBe('PROOF_EXPIRED')
    expect(expired.calls).toEqual([])
    const skewed = createVerifier(undefined, () => SIGNED_AT - 60_000)
    expect(await skewed.verify(request)).toBe(ARN)
    const early = createVerifier(undefined, () => SIGNED_AT - 60_001)
    expect(await reasonOf(early.verify(request))).toBe('PROOF_NOT_YET_VALID')
    expect(early.calls).toEqual([])
  })

  test('rejects a refused, malformed or foreign-account identity', async () => {
    expect(await reasonOf(createVerifier(() => new Response('denied', { status: 403 }))
      .verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' }))).toBe('STS_REJECTED')
    expect(await reasonOf(createVerifier(() => new Response('<xml/>', { status: 200 }))
      .verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' }))).toBe('STS_RESPONSE_INVALID')
    expect(await reasonOf(createVerifier(() => identityResponse('arn:aws:sts::999999999999:assumed-role/x/y', '999999999999'))
      .verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' }))).toBe('ACCOUNT_MISMATCH')
    expect(await reasonOf(createVerifier(() => identityResponse(ARN, '999999999999'))
      .verify({ proof: PROOF, binding: BINDING, accountId: '999999999999' }))).toBe('STS_RESPONSE_INVALID')
    expect(await reasonOf(createVerifier(() => new Response('x'.repeat(20_000), { status: 200 }))
      .verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' }))).toBe('STS_RESPONSE_INVALID')
    expect(await reasonOf(createVerifier(() => Promise.reject(new TypeError('network')))
      .verify({ proof: PROOF, binding: BINDING, accountId: '123456789012' }))).toBe('STS_UNREACHABLE')
  })

  test('rejects a malformed binding or account before any call', async () => {
    const { verify, calls } = createVerifier()
    expect(await reasonOf(verify({ proof: PROOF, binding: 'short', accountId: '123456789012' }))).toBe('BINDING_INVALID')
    expect(await reasonOf(verify({ proof: PROOF, binding: BINDING, accountId: '' }))).toBe('ACCOUNT_INVALID')
    expect(calls).toEqual([])
  })
})
