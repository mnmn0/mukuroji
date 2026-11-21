import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms'
import type { AiAssistanceExternalProvider } from '@mukuroji/contracts'
import type { AiProviderCredentialCipher } from '../../application/ports/ai-provider-credential-ports'
import { AiAssistanceError } from '../../errors'

/** Minimal KMS operations used for envelope encryption. */
export type AiProviderCredentialKmsClient = {
  /** Generates a fresh AES-256 data key bound to the encryption context. */
  generateDataKey(input: {
    keyId: string
    encryptionContext: Readonly<Record<string, string>>
  }): Promise<{ plaintext: Uint8Array, ciphertextBlob: Uint8Array }>
  /** Decrypts a stored data key with the same encryption context. */
  decrypt(input: {
    keyId: string
    ciphertextBlob: Uint8Array
    encryptionContext: Readonly<Record<string, string>>
  }): Promise<{ plaintext: Uint8Array }>
}

/**
 * Builds the KMS encryption context; IAM grants are conditioned on its service and purpose.
 *
 * @param workspaceId - Owning Workspace.
 * @param provider - Provider the key is for.
 * @returns Encryption context authenticated by KMS.
 */
export function createAiProviderCredentialEncryptionContext(
  workspaceId: string,
  provider: AiAssistanceExternalProvider,
): Record<string, string> {
  return {
    'mukuroji:service': 'ai-assistance',
    'mukuroji:purpose': 'provider-credential',
    'mukuroji:workspace': workspaceId,
    'mukuroji:provider': provider,
  }
}

/**
 * Creates the production cipher: one KMS data key per encryption, AES-256-GCM locally.
 *
 * @param keyId - KMS key ARN shared with other envelope purposes.
 * @param kmsClient - Injectable KMS boundary; the AWS SDK client is used otherwise.
 * @returns Context-bound provider key cipher.
 */
export function createKmsAiProviderCredentialCipher(
  keyId: string,
  kmsClient: AiProviderCredentialKmsClient = createDefaultKmsClient(),
): AiProviderCredentialCipher {
  return {
    async encrypt(plaintext, workspaceId, provider) {
      const encryptionContext = createAiProviderCredentialEncryptionContext(workspaceId, provider)
      let generated: { plaintext: Uint8Array, ciphertextBlob: Uint8Array } | undefined
      try {
        generated = await kmsClient.generateDataKey({ keyId, encryptionContext })
        if (generated.plaintext.byteLength !== 32 || generated.ciphertextBlob.byteLength === 0) {
          throw new Error('KMS returned invalid data key material.')
        }
        const sealed = sealWithKey(
          Buffer.from(generated.plaintext),
          plaintext,
          createAad(workspaceId, provider),
        )
        return ['kms-v1', Buffer.from(generated.ciphertextBlob).toString('base64url'), sealed].join('.')
      } catch {
        throw protectionFailedError()
      } finally {
        generated?.plaintext.fill(0)
      }
    },
    async decrypt(ciphertext, workspaceId, provider) {
      const [version, encryptedDataKey, ...sealed] = ciphertext.split('.')
      if (version !== 'kms-v1' || !encryptedDataKey || sealed.length !== 3) {
        throw protectionFailedError()
      }
      let decrypted: { plaintext: Uint8Array } | undefined
      try {
        decrypted = await kmsClient.decrypt({
          keyId,
          ciphertextBlob: Buffer.from(encryptedDataKey, 'base64url'),
          encryptionContext: createAiProviderCredentialEncryptionContext(workspaceId, provider),
        })
        if (decrypted.plaintext.byteLength !== 32) throw new Error('Invalid data key.')
        return openWithKey(
          Buffer.from(decrypted.plaintext),
          sealed.join('.'),
          createAad(workspaceId, provider),
        )
      } catch {
        throw protectionFailedError()
      } finally {
        decrypted?.plaintext.fill(0)
      }
    },
  }
}

/**
 * Creates the local-development cipher with a fixed AES-256 key; production must use KMS.
 *
 * @param key - 32-byte AES key.
 * @returns Context-bound provider key cipher.
 */
export function createLocalAiProviderCredentialCipher(key: Uint8Array): AiProviderCredentialCipher {
  if (key.byteLength !== 32) {
    throw new TypeError('The local AI provider key cipher requires a 32-byte key.')
  }
  const localKey = Buffer.from(key)
  return {
    async encrypt(plaintext, workspaceId, provider) {
      return `local-v1.${sealWithKey(localKey, plaintext, createAad(workspaceId, provider))}`
    },
    async decrypt(ciphertext, workspaceId, provider) {
      if (!ciphertext.startsWith('local-v1.')) throw protectionFailedError()
      try {
        return openWithKey(localKey, ciphertext.slice('local-v1.'.length), createAad(workspaceId, provider))
      } catch {
        throw protectionFailedError()
      }
    },
  }
}

/** Builds the AES-GCM additional data that binds a ciphertext to its Workspace and provider. */
function createAad(workspaceId: string, provider: AiAssistanceExternalProvider): Buffer {
  return Buffer.from(`mukuroji:ai-provider-credential:v1\0${workspaceId}\0${provider}`, 'utf8')
}

/** Encrypts with AES-256-GCM and returns `iv.ciphertext.tag` in base64url. */
function sealWithKey(key: Buffer, plaintext: string, aad: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.')
}

/** Authenticates and decrypts an `iv.ciphertext.tag` value. */
function openWithKey(key: Buffer, sealed: string, aad: Buffer): string {
  const [iv, encrypted, tag, extra] = sealed.split('.')
  if (!iv || !encrypted || !tag || extra !== undefined) throw new Error('Invalid envelope.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** Creates the stable error that never reveals key material or KMS details. */
function protectionFailedError(): AiAssistanceError {
  return new AiAssistanceError(
    'upstream',
    'AiAssistancePersistenceError',
    'The AI provider key could not be protected or read.',
  )
}

/** Adapts the AWS SDK KMS client to the minimal envelope boundary. */
function createDefaultKmsClient(): AiProviderCredentialKmsClient {
  const client = new KMSClient({})
  return {
    async generateDataKey({ keyId, encryptionContext }) {
      const response = await client.send(new GenerateDataKeyCommand({
        KeyId: keyId,
        KeySpec: 'AES_256',
        EncryptionContext: { ...encryptionContext },
      }))
      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error('GenerateDataKey returned incomplete key material.')
      }
      return { plaintext: response.Plaintext, ciphertextBlob: response.CiphertextBlob }
    },
    async decrypt({ keyId, ciphertextBlob, encryptionContext }) {
      const response = await client.send(new DecryptCommand({
        KeyId: keyId,
        CiphertextBlob: ciphertextBlob,
        EncryptionContext: { ...encryptionContext },
      }))
      if (!response.Plaintext) throw new Error('Decrypt returned no plaintext key.')
      return { plaintext: response.Plaintext }
    },
  }
}
