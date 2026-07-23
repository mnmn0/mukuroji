import type {
  ConnectorInstallation,
  ExternalWorkItemLink,
  UpdateExternalWorkItemLinkInput,
} from '@mukuroji/contracts'
import type { IdempotentDomainMutationRequest } from './request-control-port'

/** Validated connector installation input. */
export type InstallConnectorInput = {
  /** Connector category. */
  category: ConnectorInstallation['category']
  /** Provider code such as GitHub or Slack. */
  provider: ConnectorInstallation['provider']
  /** Installation display name. */
  name: string
  /** Scopes granted to the connector. */
  scopes: string[]
  /** Provider-side account identifier. */
  externalAccountId?: string
  /** Provider-side account display name. */
  externalAccountName?: string
  /** Credential encrypted before persistence. */
  credential?: string
}

/** Request used to install a connector. */
export type InstallConnectorRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** User starting the installation. */
  installedByUserId: string
  /** Validated connector input. */
  input: InstallConnectorInput
}

/** Request used to update connector health and lifecycle status. */
export type UpdateConnectorStatusRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation to update. */
  installationId: string
  /** New installation status. */
  status: ConnectorInstallation['status']
  /** Secret-free provider error. */
  lastError?: ConnectorInstallation['lastError']
  /** URL used to start reauthorization. */
  reauthorizationUrl?: string
  /** Timestamp of the last successful synchronization. */
  lastSyncAt?: string
  /** Single-use OAuth state bound to a needs-reauth transition. */
  reauthorizationStateId?: string
  /** User recorded as the lifecycle mutation actor. */
  updatedByUserId?: string
  /** Expected optimistic lifecycle revision. */
  expectedLifecycleRevision?: number
  /** Serialized credential already revoked at the provider. */
  expectedCredential?: string
}

/** Request used to read a secret-free connector lifecycle snapshot. */
export type ReadConnectorLifecycleSnapshotRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation to read. */
  installationId: string
}

/** Connector snapshot used to fence OAuth and status mutations. */
export type ConnectorLifecycleSnapshot = {
  /** Secret-free installation summary. */
  installation: ConnectorInstallation
  /** Optimistic lifecycle revision. */
  lifecycleRevision: number
  /** Stable revision binding queued disconnect cleanup. */
  disconnectCleanupRevision?: number
}

/** Request used to pause one bounded page of disconnected connector links. */
export type PauseConnectorExternalLinksPageRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Disconnected installation. */
  installationId: string
  /** Lifecycle revision that triggered cleanup. */
  expectedLifecycleRevision: number
  /** Optional lifecycle audit actor. */
  updatedByUserId?: string
  /** Maximum links to pause in one job. */
  limit: number
  /** Opaque continuation from the previous page. */
  cursor?: string
}

/** Result of pausing one bounded page of connector links. */
export type PauseConnectorExternalLinksPageResult = {
  /** Number of links transitioned to paused. */
  paused: number
  /** Opaque continuation when another page exists. */
  nextCursor?: string
}

/** Request used to validate the current reauthorization OAuth state. */
export type AssertConnectorReauthorizationStateRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation being reauthorized. */
  installationId: string
  /** State identifier recovered from the encrypted flow. */
  stateId: string
}

/** Request used to recover a connector with a replacement credential. */
export type RecoverConnectorRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation to recover. */
  installationId: string
  /** Replacement credential encrypted before persistence. */
  credential: string
  /** Expected current OAuth state for reauthorization callbacks. */
  expectedReauthorizationStateId?: string
  /** Credential expected by refresh compare-and-set. */
  expectedCredential?: string
  /** Durable refresh claim acquired before provider side effects. */
  refreshClaimId?: string
  /** Lifecycle reason for replacing the credential. */
  reason?: 'reauthorization' | 'refresh' | 'recovery'
  /** User recorded as the lifecycle mutation actor. */
  updatedByUserId?: string
}

/** Request used to claim a provider credential refresh. */
export type ClaimConnectorCredentialRefreshRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation whose credential is refreshed. */
  installationId: string
  /** Current serialized credential expected by the claim. */
  expectedCredential: string
  /** Identifier binding retries to one refresh invocation. */
  claimId: string
}

/** Durable connector credential refresh claim decision. */
export type ConnectorCredentialRefreshClaimResult =
  | 'claimed'
  | 'same-operation'
  | 'busy'
  | 'credential-changed'

/** Request used to release a provider credential refresh claim. */
export type ReleaseConnectorCredentialRefreshRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation whose claim is released. */
  installationId: string
  /** Current claim identifier. */
  claimId: string
}

/** Request used by a connector worker to read a credential. */
export type ReadConnectorCredentialRequest = {
  /** Workspace that owns the installation. */
  workspaceId: string
  /** Installation whose credential is read. */
  installationId: string
}

/** Validated input used to create an external Work Item link. */
export type CreateExternalWorkItemLinkInput = {
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Canonical Work Item identifier. */
  workItemId: string
  /** Connector installation managing the link. */
  installationId: string
  /** Provider-side resource type. */
  resourceType: ExternalWorkItemLink['resourceType']
  /** Immutable provider-side resource identifier. */
  externalId: string
  /** HTTPS URL of the provider resource. */
  externalUrl: string
  /** Provider key shown in the user interface. */
  displayKey?: string
  /** Synchronization direction. */
  syncDirection: ExternalWorkItemLink['syncDirection']
}

/** Request used to create an external Work Item link. */
export type CreateExternalWorkItemLinkRequest = {
  /** Workspace that owns the link. */
  workspaceId: string
  /** Validated link input. */
  input: CreateExternalWorkItemLinkInput
}

/** Request used to list external Work Item links. */
export type ListExternalWorkItemLinksRequest = {
  /** Workspace that owns the links. */
  workspaceId: string
  /** Optional exact external link identifier. */
  linkId?: string
  /** Optional canonical Work Item filter. */
  workItemId?: string
  /** Team paired with the Work Item filter. */
  teamId?: string
  /** Optional connector installation filter. */
  installationId?: string
  /** Resource type paired with the installation filter. */
  resourceType?: ExternalWorkItemLink['resourceType']
}

/** Request used to update an external Work Item link. */
export type UpdateExternalWorkItemLinkRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the link. */
  workspaceId: string
  /** Team that owns the linked Work Item. */
  teamId: string
  /** Linked canonical Work Item identifier. */
  workItemId: string
  /** Link to update. */
  linkId: string
  /** Workspace user recorded as the audit actor. */
  updatedByUserId: string
  /** Validated link update. */
  input: UpdateExternalWorkItemLinkInput
}

/** Request used to delete an external Work Item link. */
export type DeleteExternalWorkItemLinkRequest = IdempotentDomainMutationRequest & {
  /** Workspace that owns the link. */
  workspaceId: string
  /** Team that owns the linked Work Item. */
  teamId: string
  /** Linked canonical Work Item identifier. */
  workItemId: string
  /** Link to delete. */
  linkId: string
  /** Workspace user or credential recorded as the audit actor. */
  deletedByActorId?: string
}

/** Input used to fence Work Item deletion against external links. */
export type PrepareWorkItemDeletionFenceRequest = {
  /** Workspace that owns the Work Item. */
  workspaceId: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item being deleted. */
  workItemId: string
}

/** Application port for connector installation and secret lifecycle. */
export interface ConnectorPort {
  /** Installs a connector after encrypting its credential. */
  installConnector(request: InstallConnectorRequest): Promise<ConnectorInstallation>
  /** Lists secret-free connector installations for a workspace. */
  listConnectors(workspaceId: string): Promise<ConnectorInstallation[]>
  /** Reads a strongly consistent lifecycle snapshot. */
  readConnectorLifecycleSnapshot(
    request: ReadConnectorLifecycleSnapshotRequest,
  ): Promise<ConnectorLifecycleSnapshot>
  /** Updates connector health or lifecycle status. */
  updateConnectorStatus(
    request: UpdateConnectorStatusRequest,
  ): Promise<ConnectorInstallation>
  /** Validates the current reauthorization state before provider exchange. */
  assertConnectorReauthorizationState(
    request: AssertConnectorReauthorizationStateRequest,
  ): Promise<void>
  /** Claims the right to perform provider refresh side effects. */
  claimConnectorCredentialRefresh(
    request: ClaimConnectorCredentialRefreshRequest,
  ): Promise<ConnectorCredentialRefreshClaimResult>
  /** Releases a current provider refresh claim. */
  releaseConnectorCredentialRefresh(
    request: ReleaseConnectorCredentialRefreshRequest,
  ): Promise<boolean>
  /** Replaces a credential and restores a connector to connected state. */
  recoverConnector(request: RecoverConnectorRequest): Promise<ConnectorInstallation>
  /** Decrypts a credential for a connector worker. */
  readConnectorCredential(request: ReadConnectorCredentialRequest): Promise<string>
}

/** Application port for external Work Item link lifecycle. */
export interface ExternalLinkPort {
  /** Pauses one bounded page of links for a disconnected installation. */
  pauseConnectorExternalLinksPage(
    request: PauseConnectorExternalLinksPageRequest,
  ): Promise<PauseConnectorExternalLinksPageResult>
  /** Creates a unique link between an external resource and a Work Item. */
  createExternalWorkItemLink(
    request: CreateExternalWorkItemLinkRequest,
  ): Promise<ExternalWorkItemLink>
  /** Lists tenant-bound external links. */
  listExternalWorkItemLinks(
    request: ListExternalWorkItemLinksRequest,
  ): Promise<ExternalWorkItemLink[]>
  /** Updates synchronization direction or status with compare-and-set semantics. */
  updateExternalWorkItemLink(
    request: UpdateExternalWorkItemLinkRequest,
  ): Promise<ExternalWorkItemLink>
  /** Deletes an external link and its uniqueness claim. */
  deleteExternalWorkItemLink(
    request: DeleteExternalWorkItemLinkRequest,
  ): Promise<void>
}
