/** Namespace for an Enterprise bearer credential. */
export type EnterpriseCredentialKind = 'scim' | 'service-account'

/** Canonical input bound into a credential digest. */
export type EnterpriseCredentialDigestInput = {
  /** Credential namespace. */
  kind: EnterpriseCredentialKind
  /** Canonical workspace identifier. */
  workspaceId: string
  /** Canonical credential identifier. */
  credentialId: string
  /** Plaintext token retained only for the duration of the call. */
  token: string
}

/** Input for a one-time credential derivable only during its retry window. */
export type EnterpriseOneTimeCredentialInput = {
  /** Credential namespace. */
  kind: EnterpriseCredentialKind
  /** Canonical workspace identifier. */
  workspaceId: string
  /** Identifier of the entity owning the credential. */
  entityId: string
  /** Monotonic credential generation. */
  generation: number
  /** Durable receipt key bound to the request fingerprint. */
  receiptKey: string
}

/** Output port that isolates plaintext token generation, digesting, and constant-time checks. */
export interface EnterpriseCredentialProtector {
  /**
   * Creates a cryptographically random one-time bearer token.
   *
   * @param kind - Credential namespace.
   * @returns A prefixed plaintext token that must be returned only once.
   */
  createRandomToken(kind: EnterpriseCredentialKind): string
  /**
   * Converts a plaintext token into a workspace- and credential-bound digest.
   *
   * @param input - Canonical digest input.
   * @returns A persistence-safe digest.
   */
  digest(input: EnterpriseCredentialDigestInput): string
  /**
   * Deterministically derives a one-time token for an idempotent retry.
   *
   * @param input - Receipt-bound derivation input.
   * @returns The stable token for the retry window.
   */
  deriveOneTimeToken(input: EnterpriseOneTimeCredentialInput): string
  /**
   * Compares candidate and expected digests in constant time.
   *
   * @param candidate - Stored or supplied digest.
   * @param expected - Independently calculated expected digest.
   * @returns Whether both well-formed digests match.
   */
  matchesDigest(candidate: string, expected: string): boolean
}
