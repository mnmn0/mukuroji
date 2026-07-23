/** Application boundary for context-bound secret encryption. */
export interface SecretProtector {
  /** Protects plaintext with authenticated, context-bound encryption. */
  protect(plaintext: string, context: string): Promise<string>
  /** Decrypts and authenticates context-bound ciphertext. */
  unprotect(ciphertext: string, context: string): Promise<string>
}

/** Purpose-specific key separation used by KMS envelope encryption. */
export type KmsEnvelopePurpose = 'webhook' | 'connector' | 'platform-state'

/** Structured request for generating a KMS data key. */
export type KmsGenerateDataKeyRequest = {
  /** KMS key identifier or ARN. */
  keyId: string
  /** Encryption context authenticated by KMS. */
  encryptionContext: Readonly<Record<string, string>>
}

/** Minimal result required from KMS GenerateDataKey. */
export type KmsGenerateDataKeyResult = {
  /** Plaintext 256-bit data key that must be zeroized after use. */
  plaintext: Uint8Array
  /** KMS-encrypted data key stored in the envelope. */
  ciphertextBlob: Uint8Array
}

/** Structured request for decrypting an envelope data key. */
export type KmsDecryptRequest = {
  /** KMS key identifier or ARN. */
  keyId: string
  /** KMS-encrypted data key stored in the envelope. */
  ciphertextBlob: Uint8Array
  /** Encryption context matching data-key generation. */
  encryptionContext: Readonly<Record<string, string>>
}

/** Minimal result required from KMS Decrypt. */
export type KmsDecryptResult = {
  /** Plaintext 256-bit data key that must be zeroized after use. */
  plaintext: Uint8Array
}

/** Application boundary implemented by an AWS KMS adapter. */
export interface KmsEnvelopeClient {
  /** Generates a plaintext AES-256 key and its encrypted copy. */
  generateDataKey(request: KmsGenerateDataKeyRequest): Promise<KmsGenerateDataKeyResult>
  /** Decrypts the data key stored in an envelope. */
  decrypt(request: KmsDecryptRequest): Promise<KmsDecryptResult>
}

/** Purpose-specific KMS key identifiers. */
export type KmsEnvelopeKeyIds = {
  /** Key used for Webhook signing secrets. */
  webhook?: string
  /** Key used for connector provider credentials. */
  connector?: string
  /** Key used for idempotency responses and cursors. */
  platformState?: string
}
