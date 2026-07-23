import type {
  AssertConnectorReauthorizationStateRequest,
  ClaimConnectorCredentialRefreshRequest,
  ConnectorPort,
  CreateExternalWorkItemLinkRequest,
  DeleteExternalWorkItemLinkRequest,
  ExternalLinkPort,
  InstallConnectorRequest,
  ListExternalWorkItemLinksRequest,
  PauseConnectorExternalLinksPageRequest,
  ReadConnectorCredentialRequest,
  ReadConnectorLifecycleSnapshotRequest,
  RecoverConnectorRequest,
  ReleaseConnectorCredentialRefreshRequest,
  UpdateConnectorStatusRequest,
  UpdateExternalWorkItemLinkRequest,
} from '../../application/ports'

/** Focused adapter for connector installation and credential operations. */
export class ConnectorAdapter implements ConnectorPort {
  /** Storage implementation that owns connector records. */
  readonly #source: ConnectorPort

  /** Creates a focused connector adapter. */
  constructor(source: ConnectorPort) {
    this.#source = source
  }

  /** Installs a connector. */
  installConnector(request: InstallConnectorRequest) {
    return this.#source.installConnector(request)
  }

  /** Lists connectors. */
  listConnectors(workspaceId: string) {
    return this.#source.listConnectors(workspaceId)
  }

  /** Reads a connector lifecycle snapshot. */
  readConnectorLifecycleSnapshot(request: ReadConnectorLifecycleSnapshotRequest) {
    return this.#source.readConnectorLifecycleSnapshot(request)
  }

  /** Updates connector status. */
  updateConnectorStatus(request: UpdateConnectorStatusRequest) {
    return this.#source.updateConnectorStatus(request)
  }

  /** Verifies current reauthorization state. */
  assertConnectorReauthorizationState(
    request: AssertConnectorReauthorizationStateRequest,
  ) {
    return this.#source.assertConnectorReauthorizationState(request)
  }

  /** Claims a connector credential refresh. */
  claimConnectorCredentialRefresh(request: ClaimConnectorCredentialRefreshRequest) {
    return this.#source.claimConnectorCredentialRefresh(request)
  }

  /** Releases a connector credential refresh claim. */
  releaseConnectorCredentialRefresh(
    request: ReleaseConnectorCredentialRefreshRequest,
  ) {
    return this.#source.releaseConnectorCredentialRefresh(request)
  }

  /** Recovers a connector credential. */
  recoverConnector(request: RecoverConnectorRequest) {
    return this.#source.recoverConnector(request)
  }

  /** Reads a connector credential for a worker. */
  readConnectorCredential(request: ReadConnectorCredentialRequest) {
    return this.#source.readConnectorCredential(request)
  }
}

/** Focused adapter for external Work Item link operations. */
export class ExternalLinkAdapter implements ExternalLinkPort {
  /** Storage implementation that owns external-link records. */
  readonly #source: ExternalLinkPort

  /** Creates a focused external-link adapter. */
  constructor(source: ExternalLinkPort) {
    this.#source = source
  }

  /** Pauses one page of connector-owned links. */
  pauseConnectorExternalLinksPage(request: PauseConnectorExternalLinksPageRequest) {
    return this.#source.pauseConnectorExternalLinksPage(request)
  }

  /** Creates an external Work Item link. */
  createExternalWorkItemLink(request: CreateExternalWorkItemLinkRequest) {
    return this.#source.createExternalWorkItemLink(request)
  }

  /** Lists external Work Item links. */
  listExternalWorkItemLinks(request: ListExternalWorkItemLinksRequest) {
    return this.#source.listExternalWorkItemLinks(request)
  }

  /** Updates an external Work Item link. */
  updateExternalWorkItemLink(request: UpdateExternalWorkItemLinkRequest) {
    return this.#source.updateExternalWorkItemLink(request)
  }

  /** Deletes an external Work Item link. */
  deleteExternalWorkItemLink(request: DeleteExternalWorkItemLinkRequest) {
    return this.#source.deleteExternalWorkItemLink(request)
  }
}
