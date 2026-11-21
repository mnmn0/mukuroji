import type {
  AiAssistanceExternalProvider,
  AiAssistanceProviderCredentials,
  DeleteAiAssistanceProviderCredentialRequest,
  PutAiAssistanceProviderCredentialRequest,
} from '@mukuroji/contracts'
import type { AuditEventV1 } from '../../../audit'
import type {
  AiAssistanceActor,
  AiAssistancePolicyAuthorization,
  AiAssistancePolicyAuthorizationFence,
} from './ai-assistance-ports'

/** Stored row for one Workspace provider key; the key itself stays encrypted. */
export type StoredAiProviderCredential = {
  /** Workspace that owns the key. */
  workspaceId: string
  /** External provider the key authenticates to. */
  provider: AiAssistanceExternalProvider
  /** Monotonic revision; removal also advances it. */
  revision: number
  /** ISO 8601 timestamp of the latest change. */
  updatedAt: string
  /** Envelope ciphertext; absent after removal. */
  ciphertext?: string
  /** Last four key characters for display; absent after removal. */
  keyHint?: string
}

/** Context-bound authenticated encryption for provider keys. */
export interface AiProviderCredentialCipher {
  /**
   * Encrypts one key bound to its Workspace and provider.
   *
   * @param plaintext - API key to protect.
   * @param workspaceId - Owning Workspace bound into the encryption context.
   * @param provider - Provider bound into the encryption context.
   * @returns Opaque ciphertext safe to persist.
   */
  encrypt(
    plaintext: string,
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<string>
  /**
   * Decrypts one key, failing when the Workspace or provider does not match.
   *
   * @param ciphertext - Stored envelope ciphertext.
   * @param workspaceId - Workspace expected in the encryption context.
   * @param provider - Provider expected in the encryption context.
   * @returns The plaintext API key.
   */
  decrypt(
    ciphertext: string,
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<string>
}

/** Persistence boundary for provider key rows. */
export interface AiProviderCredentialStore {
  /**
   * Reads one provider row with strong consistency.
   *
   * @param workspaceId - Owning Workspace.
   * @param provider - External provider.
   * @returns The stored row, or undefined when none was ever written.
   */
  getProviderCredential(
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<StoredAiProviderCredential | undefined>
  /**
   * Writes one revision-fenced row and its audit event in one transaction.
   *
   * @param memberId - Member key bound to the authorization fence.
   * @param credential - Next row; omit ciphertext to remove the key.
   * @param expectedRevision - Revision observed by the manager.
   * @param authorizationFence - Fresh management authorization fence.
   * @param auditEvent - Key-free audit event appended in the same transaction.
   */
  putProviderCredentialWithAudit(
    memberId: string,
    credential: StoredAiProviderCredential,
    expectedRevision: number,
    authorizationFence: AiAssistancePolicyAuthorizationFence,
    auditEvent: AuditEventV1,
  ): Promise<void>
}

/** Key-free description of one key change used to build its audit event. */
export type AiProviderCredentialAuditInput = {
  /** Authenticated manager. */
  actor: AiAssistanceActor
  /** External provider whose key changed. */
  provider: AiAssistanceExternalProvider
  /** Whether the key was registered, replaced, or removed. */
  action: 'created' | 'updated' | 'deleted'
  /** Revision before the change. */
  previousRevision: number
  /** Revision after the change. */
  revision: number
  /** ISO 8601 time of the change. */
  occurredAt: string
}

/** Application service for manager-owned provider keys. */
export interface AiProviderCredentialService {
  /**
   * Lists key status for every external provider without key material.
   *
   * @param actor - Workspace manager reading the status; non-managers are rejected.
   * @returns Configured flag, last four characters, and revision per provider.
   */
  list(actor: AiAssistanceActor): Promise<AiAssistanceProviderCredentials>
  /**
   * Registers or replaces one provider key.
   *
   * The write commits only when `request.expectedRevision` matches the stored
   * revision and the fence from `authorization.getCommitFence()` still holds, so a
   * manager who lost the role or a stale editor cannot overwrite the key.
   *
   * @param actor - Workspace manager making the change.
   * @param provider - External provider the key authenticates to.
   * @param request - Plaintext key and the revision the editor last saw.
   * @param authorization - Fresh management check and commit fence.
   * @returns Key-free status for every provider after the change.
   */
  put(
    actor: AiAssistanceActor,
    provider: AiAssistanceExternalProvider,
    request: PutAiAssistanceProviderCredentialRequest,
    authorization: AiAssistancePolicyAuthorization,
  ): Promise<AiAssistanceProviderCredentials>
  /**
   * Removes one provider key under the same revision and commit-fence checks as `put`.
   *
   * @param actor - Workspace manager making the change.
   * @param provider - External provider whose key is removed.
   * @param request - Revision the editor last saw.
   * @param authorization - Fresh management check and commit fence.
   * @returns Key-free status for every provider after the change.
   */
  delete(
    actor: AiAssistanceActor,
    provider: AiAssistanceExternalProvider,
    request: DeleteAiAssistanceProviderCredentialRequest,
    authorization: AiAssistancePolicyAuthorization,
  ): Promise<AiAssistanceProviderCredentials>
  /**
   * Returns whether a Workspace has a key for the provider, without decrypting it.
   *
   * @param workspaceId - Workspace that will run a generation.
   * @param provider - External provider of the selected model.
   * @returns Whether an encrypted key row exists.
   */
  isConfigured(
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<boolean>
  /**
   * Decrypts the Workspace key for one provider call.
   *
   * @param workspaceId - Workspace running the generation.
   * @param provider - External provider of the selected model.
   * @returns The plaintext key, or undefined when none is registered.
   */
  resolveApiKey(
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<string | undefined>
}
