import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  EnterpriseCredentialDigestInput,
  EnterpriseCredentialKind,
  EnterpriseCredentialProtector,
  EnterpriseOneTimeCredentialInput,
} from '../../application/ports/enterprise-credential-protector'
import { EnterpriseIdentityError } from '../../errors'

/** Output adapter that protects Enterprise credentials with HMAC-SHA-256. */
export class HmacEnterpriseCredentialProtector implements EnterpriseCredentialProtector {
  /** Secret used only for credential digests and one-time derivation. */
  private readonly secret: string

  /**
   * Creates an HMAC Enterprise credential protector.
   *
   * @param secret - Stable HMAC secret containing 32 to 256 characters.
   */
  constructor(secret: string) {
    if (secret.length < 32 || secret.length > 256) {
      throw new EnterpriseIdentityError(
        503,
        'EnterpriseIdentitySecretInvalid',
        'Enterprise identity token hash secret must contain between 32 and 256 characters.',
      )
    }
    this.secret = secret
  }

  /**
   * Creates a cryptographically random one-time bearer token.
   *
   * @param kind - Credential namespace.
   * @returns A prefixed plaintext token.
   */
  createRandomToken(kind: EnterpriseCredentialKind): string {
    return `${credentialPrefix(kind)}_${randomBytes(32).toString('base64url')}`
  }

  /**
   * Converts a plaintext token into a workspace- and credential-bound digest.
   *
   * @param input - Canonical digest input.
   * @returns A persistence-safe HMAC digest.
   */
  digest(input: EnterpriseCredentialDigestInput): string {
    return createHmac('sha256', this.secret)
      .update([
        input.kind,
        requireCredentialText(input.workspaceId, 'Workspace ID'),
        requireCredentialText(input.credentialId, 'Credential ID'),
        requireCredentialText(input.token, 'Credential'),
      ].join('\0'))
      .digest('hex')
  }

  /**
   * Deterministically derives a token within an idempotent retry window.
   *
   * @param input - Receipt-bound derivation input.
   * @returns The stable token for the retry window.
   */
  deriveOneTimeToken(input: EnterpriseOneTimeCredentialInput): string {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new EnterpriseIdentityError(
        400,
        'EnterpriseCredentialGenerationInvalid',
        'Credential generation must be a positive integer.',
      )
    }
    return `${credentialPrefix(input.kind)}_${createHmac('sha256', this.secret)
      .update([
        'enterprise-one-time-credential-v1',
        input.kind,
        requireCredentialText(input.workspaceId, 'Workspace ID'),
        requireCredentialText(input.entityId, 'Credential entity ID'),
        String(input.generation),
        requireCredentialText(input.receiptKey, 'Credential receipt key'),
      ].join('\0'))
      .digest('base64url')}`
  }

  /**
   * Compares digests in constant time and fails closed for malformed input.
   *
   * @param candidate - Candidate digest.
   * @param expected - Expected digest.
   * @returns Whether both well-formed digests match.
   */
  matchesDigest(candidate: string, expected: string): boolean {
    if (
      candidate.length !== expected.length ||
      !/^[0-9a-f]{64}$/u.test(candidate) ||
      !/^[0-9a-f]{64}$/u.test(expected)
    ) return false
    return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'))
  }
}

/** Returns the public token prefix for a credential namespace. */
function credentialPrefix(kind: EnterpriseCredentialKind): 'msc' | 'msa' {
  return kind === 'scim' ? 'msc' : 'msa'
}

/** Validates canonical text before it reaches the HMAC boundary. */
function requireCredentialText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new EnterpriseIdentityError(
      400,
      'EnterpriseIdentityValidationFailed',
      `${label} is required.`,
    )
  }
  return normalized
}
