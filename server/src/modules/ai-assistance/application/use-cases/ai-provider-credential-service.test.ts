import { describe, expect, test } from 'bun:test'
import {
  createAuditEvent,
  createMutationAuditContext,
  type AuditEventV1,
} from '../../../audit'
import type { AiAssistanceActor, AiAssistancePolicyAuthorization } from '../ports/ai-assistance-ports'
import type {
  AiProviderCredentialAuditInput,
  AiProviderCredentialCipher,
  AiProviderCredentialStore,
  StoredAiProviderCredential,
} from '../ports/ai-provider-credential-ports'
import { createAiProviderCredentialService } from './ai-provider-credential-service'

const manager: AiAssistanceActor = {
  workspaceId: 'workspace-1',
  memberId: 'member-1',
  actorId: 'user-1',
  auditActorKind: 'user',
  traceId: 'trace-1',
  canManagePolicy: true,
}

const currentAuthorization: AiAssistancePolicyAuthorization = {
  isCurrent: async () => true,
  getCommitFence: async () => ({ workspaceMemberVersion: 1, workspaceRole: 'admin' }),
}

/** Reversible test cipher bound to the Workspace and provider, so a moved row cannot be read. */
const testCipher: AiProviderCredentialCipher = {
  async encrypt(plaintext, workspaceId, provider) {
    return `test.${Buffer.from(`${workspaceId}|${provider}|${plaintext}`).toString('base64url')}`
  },
  async decrypt(ciphertext, workspaceId, provider) {
    const decoded = Buffer.from(ciphertext.slice('test.'.length), 'base64url').toString('utf8')
    const prefix = `${workspaceId}|${provider}|`
    if (!decoded.startsWith(prefix)) throw new Error('context mismatch')
    return decoded.slice(prefix.length)
  },
}

/** In-memory store that records writes and enforces the revision fence. */
function createStore(): AiProviderCredentialStore & {
  rows: Map<string, StoredAiProviderCredential>
  audits: AuditEventV1[]
} {
  const rows = new Map<string, StoredAiProviderCredential>()
  const audits: AuditEventV1[] = []
  return {
    rows,
    audits,
    async getProviderCredential(workspaceId, provider) {
      return rows.get(`${workspaceId}:${provider}`)
    },
    async putProviderCredentialWithAudit(_memberId, credential, expectedRevision, _fence, audit) {
      const key = `${credential.workspaceId}:${credential.provider}`
      if ((rows.get(key)?.revision ?? 0) !== expectedRevision) throw new Error('conflict')
      rows.set(key, credential)
      audits.push(audit)
    },
  }
}

/** Creates the service with a local cipher and recorded audit inputs. */
function createService(store = createStore()) {
  const auditInputs: AiProviderCredentialAuditInput[] = []
  const service = createAiProviderCredentialService({
    store,
    cipher: testCipher,
    enabledProviders: new Set(['anthropic']),
    createAuditEvent: (input) => {
      auditInputs.push(input)
      return createAuditEvent({
        context: createMutationAuditContext({
          workspaceId: input.actor.workspaceId,
          actor: { id: input.actor.actorId, kind: input.actor.auditActorKind },
          idempotencyKey: `test:${input.provider}:${input.revision}`,
          request: { method: 'PUT', path: '/test', body: {} },
          source: { kind: 'api', method: 'PUT', route: '/test' },
          occurredAt: input.occurredAt,
        }),
        eventType: 'ai-assistance.provider-credential.updated',
        entity: { type: 'workspace', id: input.actor.workspaceId },
        target: { type: 'workspace', id: input.actor.workspaceId },
        action: input.action,
        summary: 'test',
        expiresAt: 1_800_000_000,
      })
    },
    now: () => new Date('2026-11-21T00:00:00.000Z'),
  })
  return { service, store, auditInputs }
}

describe('createAiProviderCredentialService', () => {
  test('stores an encrypted key and returns only its last four characters', async () => {
    const { service, store, auditInputs } = createService()

    const result = await service.put(
      manager,
      'anthropic',
      { apiKey: 'sk-ant-api03-secret-ABCD', expectedRevision: 0 },
      currentAuthorization,
    )

    expect(result.providers).toEqual([
      {
        provider: 'anthropic',
        deploymentEnabled: true,
        configured: true,
        keyHint: 'ABCD',
        revision: 1,
        updatedAt: '2026-11-21T00:00:00.000Z',
      },
      { provider: 'openai', deploymentEnabled: false, configured: false, revision: 0 },
    ])
    expect(JSON.stringify(result)).not.toContain('secret')
    const row = store.rows.get('workspace-1:anthropic')
    expect(row?.ciphertext).toBeDefined()
    expect(row?.ciphertext).not.toContain('secret')
    expect(auditInputs.map((input) => input.action)).toEqual(['created'])
    expect(JSON.stringify(auditInputs)).not.toContain('secret')
    expect(await service.resolveApiKey('workspace-1', 'anthropic')).toBe('sk-ant-api03-secret-ABCD')
    expect(await service.isConfigured('workspace-1', 'anthropic')).toBe(true)
    expect(await service.resolveApiKey('workspace-2', 'anthropic')).toBeUndefined()
  })

  test('replaces and removes a key with advancing revisions', async () => {
    const { service, auditInputs } = createService()
    await service.put(manager, 'anthropic', { apiKey: 'sk-ant-first-key-000001', expectedRevision: 0 }, currentAuthorization)
    await service.put(manager, 'anthropic', { apiKey: 'sk-ant-second-key-00002', expectedRevision: 1 }, currentAuthorization)

    const removed = await service.delete(manager, 'anthropic', { expectedRevision: 2 }, currentAuthorization)

    expect(removed.providers[0]).toEqual({
      provider: 'anthropic',
      deploymentEnabled: true,
      configured: false,
      revision: 3,
      updatedAt: '2026-11-21T00:00:00.000Z',
    })
    expect(auditInputs.map((input) => input.action)).toEqual(['created', 'updated', 'deleted'])
    expect(await service.resolveApiKey('workspace-1', 'anthropic')).toBeUndefined()
  })

  test('rejects a stale revision, a non-manager, a disabled provider, and a mismatched key', async () => {
    const { service } = createService()

    await expect(service.put(manager, 'anthropic', { apiKey: 'sk-ant-api03-key-000000', expectedRevision: 4 }, currentAuthorization))
      .rejects.toMatchObject({ code: 'AiAssistanceRevisionConflict' })
    await expect(service.put({ ...manager, canManagePolicy: false }, 'anthropic', { apiKey: 'sk-ant-api03-key-000000', expectedRevision: 0 }, currentAuthorization))
      .rejects.toMatchObject({ code: 'AiAssistanceDisabled' })
    await expect(service.list({ ...manager, canManagePolicy: false }))
      .rejects.toMatchObject({ code: 'AiAssistanceDisabled' })
    await expect(service.put(manager, 'openai', { apiKey: 'sk-proj-openai-key-0000', expectedRevision: 0 }, currentAuthorization))
      .rejects.toMatchObject({ code: 'AiAssistanceProviderNotEnabled' })
    await expect(service.put(manager, 'anthropic', { apiKey: 'sk-proj-openai-key-0000', expectedRevision: 0 }, currentAuthorization))
      .rejects.toMatchObject({ code: 'InvalidAiAssistanceProviderCredential' })
  })

  test('does not write when management authorization is no longer current', async () => {
    const { service, store } = createService()

    await expect(service.put(
      manager,
      'anthropic',
      { apiKey: 'sk-ant-api03-key-000000', expectedRevision: 0 },
      { isCurrent: async () => false, getCommitFence: async () => undefined },
    )).rejects.toMatchObject({ code: 'AiAssistanceAuthorizationChanged' })
    expect(store.rows.size).toBe(0)
  })
})
