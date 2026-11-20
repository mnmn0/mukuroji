import type {
  DataMigrationOperatorProofRequest,
  DataMigrationOperatorVerifier,
} from '../../application/ports/data-migration-ports'

/**
 * Signed header that binds a presigned `GetCallerIdentity` request to one
 * data migration invocation. STS rejects the request unless the header is
 * sent with the exact signed value.
 */
export const DATA_MIGRATION_OPERATOR_PROOF_HEADER = 'x-mukuroji-data-migration-request'

/** Longest accepted proof validity in seconds. */
export const DATA_MIGRATION_OPERATOR_PROOF_MAX_EXPIRES_SECONDS = 900

/** Query parameters a presigned `GetCallerIdentity` URL may carry. */
const ALLOWED_QUERY_PARAMETERS = new Set([
  'Action',
  'Version',
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-Security-Token',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
])

/** Query parameters every proof must carry. */
const REQUIRED_QUERY_PARAMETERS = [
  'Action',
  'Version',
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
]

/** STS call timeout. */
const STS_TIMEOUT_MILLISECONDS = 5_000

/** Largest STS response body read. */
const MAX_RESPONSE_BYTES = 16_384

/** Shape of an IAM or STS principal ARN in the standard partition. */
const PRINCIPAL_ARN_PATTERN = /^arn:aws:(?:iam|sts)::[0-9]{12}:[\x21-\x7e]{1,1900}$/u

/** Shape of an AWS account identifier. */
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u

/** Shape of an AWS region name. */
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/u

/** Options of the STS operator verifier. */
export type StsDataMigrationOperatorVerifierOptions = {
  /** Region of the function; the proof must target this region's STS endpoint. */
  readonly region: string
  /** HTTP client; defaults to the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
}

/** Reason a proof was rejected, for logs and tests only. */
export class DataMigrationOperatorProofError extends Error {
  /** Stable reason code; never contains the proof. */
  readonly reason: string

  /**
   * Creates a rejection.
   *
   * @param reason - Stable reason code.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'DataMigrationOperatorProofError'
    this.reason = reason
  }
}

/**
 * Creates a verifier that authenticates an operator from a presigned STS
 * `GetCallerIdentity` URL. The URL must target this region's STS endpoint
 * and must have the binding header signed; the verifier sends that header
 * with the expected binding, so STS accepts the request only when the
 * operator signed this exact invocation. The returned ARN comes from STS,
 * never from the payload.
 *
 * @param options - Region and HTTP client.
 * @returns The verifier.
 */
export function createStsDataMigrationOperatorVerifier(
  options: StsDataMigrationOperatorVerifierOptions,
): DataMigrationOperatorVerifier {
  if (!REGION_PATTERN.test(options.region)) throw new DataMigrationOperatorProofError('REGION_INVALID')
  const fetchImplementation = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const expectedHost = `sts.${options.region}.amazonaws.com`
  return async (request: DataMigrationOperatorProofRequest): Promise<string> => {
    if (!ACCOUNT_ID_PATTERN.test(request.accountId)) throw new DataMigrationOperatorProofError('ACCOUNT_INVALID')
    if (!/^[0-9a-f]{64}$/u.test(request.binding)) throw new DataMigrationOperatorProofError('BINDING_INVALID')
    const url = parseProofUrl(request.proof, expectedHost)
    let response: Response
    try {
      response = await fetchImplementation(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [DATA_MIGRATION_OPERATOR_PROOF_HEADER]: request.binding,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(STS_TIMEOUT_MILLISECONDS),
      })
    } catch {
      throw new DataMigrationOperatorProofError('STS_UNREACHABLE')
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new DataMigrationOperatorProofError('STS_REJECTED')
    }
    const identity = readCallerIdentity(await readBoundedText(response))
    if (identity.account !== request.accountId) throw new DataMigrationOperatorProofError('ACCOUNT_MISMATCH')
    return identity.arn
  }
}

/**
 * Parses a proof URL and checks that it is a presigned `GetCallerIdentity`
 * call to the expected STS host with the binding header signed.
 *
 * @param proof - Untrusted proof text.
 * @param expectedHost - Regional STS host.
 * @returns The parsed URL.
 */
function parseProofUrl(proof: string, expectedHost: string): URL {
  let url: URL
  try {
    url = new URL(proof)
  } catch {
    throw new DataMigrationOperatorProofError('PROOF_MALFORMED')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.hash !== ''
  ) {
    throw new DataMigrationOperatorProofError('PROOF_TARGET_INVALID')
  }
  const names = [...url.searchParams.keys()]
  if (names.some((name) => !ALLOWED_QUERY_PARAMETERS.has(name)) || new Set(names).size !== names.length) {
    throw new DataMigrationOperatorProofError('PROOF_PARAMETERS_INVALID')
  }
  if (REQUIRED_QUERY_PARAMETERS.some((name) => !url.searchParams.has(name))) {
    throw new DataMigrationOperatorProofError('PROOF_PARAMETERS_INVALID')
  }
  const signedHeaders = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';')
  const expires = Number(url.searchParams.get('X-Amz-Expires'))
  const valid = url.searchParams.get('Action') === 'GetCallerIdentity' &&
    url.searchParams.get('Version') === '2011-06-15' &&
    url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    signedHeaders.includes('host') &&
    signedHeaders.includes(DATA_MIGRATION_OPERATOR_PROOF_HEADER) &&
    Number.isSafeInteger(expires) &&
    expires >= 1 &&
    expires <= DATA_MIGRATION_OPERATOR_PROOF_MAX_EXPIRES_SECONDS
  if (!valid) throw new DataMigrationOperatorProofError('PROOF_PARAMETERS_INVALID')
  return url
}

/**
 * Reads a response body up to {@link MAX_RESPONSE_BYTES}.
 *
 * @param response - STS response.
 * @returns The body text.
 */
async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new DataMigrationOperatorProofError('STS_RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new DataMigrationOperatorProofError('STS_RESPONSE_INVALID')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Extracts the caller ARN and account from a JSON `GetCallerIdentity` response.
 *
 * @param text - Response body.
 * @returns The principal ARN and account.
 */
function readCallerIdentity(text: string): {
  /** Principal ARN. */
  readonly arn: string
  /** Account identifier. */
  readonly account: string
} {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new DataMigrationOperatorProofError('STS_RESPONSE_INVALID')
  }
  const result = readRecord(readRecord(body)?.GetCallerIdentityResponse)?.GetCallerIdentityResult
  const identity = readRecord(result)
  const arn = identity?.Arn
  const account = identity?.Account
  if (typeof arn !== 'string' || typeof account !== 'string' || !PRINCIPAL_ARN_PATTERN.test(arn)) {
    throw new DataMigrationOperatorProofError('STS_RESPONSE_INVALID')
  }
  if (arn.split(':')[4] !== account) throw new DataMigrationOperatorProofError('STS_RESPONSE_INVALID')
  return { arn, account }
}

/**
 * Narrows a value to a plain object.
 *
 * @param value - Value to narrow.
 * @returns The object, or `undefined`.
 */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}
