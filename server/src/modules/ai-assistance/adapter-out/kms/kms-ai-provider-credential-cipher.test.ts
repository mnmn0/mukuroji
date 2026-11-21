import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  createKmsAiProviderCredentialCipher,
  createLocalAiProviderCredentialCipher,
  type AiProviderCredentialKmsClient,
} from './kms-ai-provider-credential-cipher'

/** Fake KMS that wraps data keys with a fixed key and checks the encryption context. */
function createFakeKms(): AiProviderCredentialKmsClient & {
  contexts: Array<Readonly<Record<string, string>>>
} {
  const contexts: Array<Readonly<Record<string, string>>> = []
  const issued = new Map<string, { key: Uint8Array, context: string }>()
  return {
    contexts,
    async generateDataKey({ encryptionContext }) {
      contexts.push(encryptionContext)
      const key = randomBytes(32)
      const handle = randomBytes(16)
      issued.set(handle.toString('hex'), {
        key: Uint8Array.from(key),
        context: JSON.stringify(encryptionContext),
      })
      return { plaintext: key, ciphertextBlob: handle }
    },
    async decrypt({ ciphertextBlob, encryptionContext }) {
      const entry = issued.get(Buffer.from(ciphertextBlob).toString('hex'))
      if (!entry || entry.context !== JSON.stringify(encryptionContext)) {
        throw new Error('InvalidCiphertextException')
      }
      return { plaintext: Uint8Array.from(entry.key) }
    },
  }
}

describe('createKmsAiProviderCredentialCipher', () => {
  test('round-trips a key and binds the KMS context to Workspace and provider', async () => {
    const kms = createFakeKms()
    const cipher = createKmsAiProviderCredentialCipher('arn:aws:kms:ap-northeast-1:1:key/k', kms)

    const ciphertext = await cipher.encrypt('sk-ant-secret-value-0000', 'workspace-1', 'anthropic')

    expect(ciphertext.startsWith('kms-v1.')).toBe(true)
    expect(ciphertext).not.toContain('secret')
    expect(kms.contexts).toEqual([{
      'mukuroji:service': 'ai-assistance',
      'mukuroji:purpose': 'provider-credential',
      'mukuroji:workspace': 'workspace-1',
      'mukuroji:provider': 'anthropic',
    }])
    expect(await cipher.decrypt(ciphertext, 'workspace-1', 'anthropic'))
      .toBe('sk-ant-secret-value-0000')
  })

  test('refuses to decrypt for another Workspace or provider', async () => {
    const cipher = createKmsAiProviderCredentialCipher('key', createFakeKms())
    const ciphertext = await cipher.encrypt('sk-ant-secret-value-0000', 'workspace-1', 'anthropic')

    await expect(cipher.decrypt(ciphertext, 'workspace-2', 'anthropic'))
      .rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
    await expect(cipher.decrypt(ciphertext, 'workspace-1', 'openai'))
      .rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
  })
})

describe('createLocalAiProviderCredentialCipher', () => {
  test('authenticates the Workspace and provider through AES-GCM additional data', async () => {
    const cipher = createLocalAiProviderCredentialCipher(randomBytes(32))
    const ciphertext = await cipher.encrypt('sk-openai-value-000000', 'workspace-1', 'openai')

    expect(await cipher.decrypt(ciphertext, 'workspace-1', 'openai')).toBe('sk-openai-value-000000')
    await expect(cipher.decrypt(ciphertext, 'workspace-2', 'openai'))
      .rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
  })
})
