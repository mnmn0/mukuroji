/**
 * Tenant administration contract schema version.
 */
export const TENANT_ADMINISTRATION_SCHEMA_VERSION = 3 as const

/**
 * Locales supported by tenant-owned defaults.
 */
export type TenantLocale = 'ja' | 'en'

/**
 * Tenant defaults applied when new members or resources are created.
 */
export type TenantDefaultPolicy = {
  /** The Workspace role used when an invitation omits an explicit role. */
  defaultMemberRole: 'member' | 'guest'
}

/**
 * Tenant profile and ownership metadata.
 */
export type TenantProfile = {
  /** Canonical Workspace identifier used as the tenant identifier. */
  workspaceId: string
  /** Stable Workspace member key for the current owner. */
  ownerMemberKey: string
  /** Deployment region selected for tenant data. */
  region: string
  /** Locale used for tenant-owned defaults. */
  locale: TenantLocale
  /** Defaults applied to newly created tenant resources. */
  defaultPolicy: TenantDefaultPolicy
  /** Whether normal tenant access remains enabled. */
  status: 'active' | 'closing' | 'closed'
  /** Timestamp at which a verified closure sealed the tenant. */
  closedAt?: string
  /** Closure operation that sealed the tenant. */
  closedByOperationId?: string
  /** Optimistic concurrency revision for profile changes. */
  revision: number
  /** Profile creation timestamp. */
  createdAt: string
  /** Profile last-update timestamp. */
  updatedAt: string
}

/**
 * Data governance and cryptographic policy for a tenant.
 */
export type TenantGovernancePolicy = {
  /** Canonical Workspace identifier used as the tenant identifier. */
  workspaceId: string
  /** Number of days audit records must be retained. */
  auditRetentionDays: number
  /** Whether deletion and retention expiry are suspended. */
  legalHold: boolean
  /** Region in which tenant data must remain. */
  dataResidency: string
  /** Encryption key ownership policy for tenant data. */
  encryptionKeyPolicy: 'aws-managed' | 'customer-managed'
  /** Optimistic concurrency revision for governance changes. */
  revision: number
  /** Governance policy last-update timestamp. */
  updatedAt: string
  /** Stable member key that performed the last update. */
  updatedBy: string
}

/**
 * Governance controls enforced by the deployed tenant data plane.
 */
export type TenantGovernanceEnforcement = {
  /** AWS region in which the deployed tenant data plane is hosted. */
  dataResidency: string
  /** Encryption-key ownership implemented by the deployed data stores. */
  encryptionKeyPolicy: 'aws-managed' | 'customer-managed'
}

/** Durable state of audit-retention reconciliation. */
export type TenantRetentionReconciliationStatus =
  | 'pending'
  | 'running'
  | 'completed'

/** Progress of tenant audit TTL reconciliation after a policy change. */
export type TenantRetentionReconciliation = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Governance revision whose retention policy is being applied. */
  governanceRevision: number
  /** Durable reconciliation state. */
  status: TenantRetentionReconciliationStatus
  /** Audit retention period being applied. */
  retentionDays: number
  /** Whether TTL is removed for legal hold. */
  legalHold: boolean
  /** Number of audit events processed across completed pages. */
  processedEvents: number
  /** Last processed event key used to resume a bounded page. */
  cursorEventId?: string
  /** Optimistic concurrency revision for the reconciliation job. */
  revision: number
  /** Job last-update timestamp. */
  updatedAt: string
  /** Stable service or member key that requested the policy change. */
  updatedBy: string
}

/**
 * Durable operation kinds exposed by tenant administration.
 */
export type TenantOperationKind = 'export' | 'closure'

/**
 * Durable operation states used by export and account-closure workflows.
 */
export type TenantOperationStatus =
  | 'requested'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'verified'

/**
 * Bounded steps used by a tenant data export.
 */
export type TenantExportStep = 'snapshot' | 'prepare-artifact' | 'verify-artifact'

/**
 * Bounded steps used by an account-closure workflow.
 */
export type TenantClosureStep =
  | 'export'
  | 'revoke-access'
  | 'anonymize-members'
  | 'delete-data'
  | 'delete-secrets'
  | 'verify'

/**
 * Execution evidence required before a durable workflow step is completed.
 */
export type TenantOperationStepProof = {
  /** Workflow step completed by the trusted executor. */
  step: TenantExportStep | TenantClosureStep
  /** Opaque reference to the executor's immutable evidence. */
  evidenceReference: string
}

/**
 * One durable tenant operation and its auditable progress.
 */
export type TenantOperation = {
  /** Tenant operation identifier. */
  operationId: string
  /** Canonical Workspace identifier used as the tenant identifier. */
  workspaceId: string
  /** Operation kind. */
  kind: TenantOperationKind
  /** Current operation state. */
  status: TenantOperationStatus
  /** Stable member key that requested the operation. */
  requestedBy: string
  /** Operation request timestamp. */
  requestedAt: string
  /** Operation last-update timestamp. */
  updatedAt: string
  /** Stable member key that performed the last transition. */
  updatedBy: string
  /** Current workflow step, when the operation has started. */
  currentStep?: TenantExportStep | TenantClosureStep
  /** Steps that have reached a durable completion point. */
  completedSteps: Array<TenantExportStep | TenantClosureStep>
  /** Opaque evidence reference for the most recently completed step. */
  lastEvidenceReference?: string
  /** Safe, stable failure code when the operation failed. */
  failureCode?: string
  /** Requested export format, when this is an export operation. */
  exportFormat?: 'jsonl' | 'csv'
  /** Optimistic concurrency revision for operation transitions. */
  revision: number
}

/** One short-lived URL for a generated tenant export artifact object. */
export type TenantExportDownloadFile = {
  /** Relative artifact path shown to the requesting administrator. */
  name: string
  /** Short-lived URL authorized for this artifact object only. */
  url: string
}

/** Authorized artifact locations returned for a completed tenant export. */
export type TenantExportDownload = {
  /** Timestamp at which all returned URLs expire. */
  expiresAt: string
  /** Every generated artifact object available for download. */
  files: TenantExportDownloadFile[]
}

/**
 * Tenant administration aggregate returned to the management UI.
 */
export type TenantAdministrationSnapshot = {
  /** Contract schema version. */
  schemaVersion: typeof TENANT_ADMINISTRATION_SCHEMA_VERSION
  /** Tenant ownership and regional profile. */
  profile: TenantProfile
  /** Retention, residency, and encryption policy. */
  governance: TenantGovernancePolicy
  /** Residency and key controls enforced by the deployed data plane. */
  governanceEnforcement: TenantGovernanceEnforcement
  /** Audit TTL reconciliation progress after a retention or legal-hold change. */
  retentionReconciliation?: TenantRetentionReconciliation
  /** Active operation or completed closure awaiting administrator verification. */
  activeOperation?: TenantOperation
  /** Newest lifecycle operations retained for progress and result inspection. */
  recentOperations: TenantOperation[]
}

/**
 * Mutable profile fields accepted by the tenant administration API.
 */
export type UpdateTenantProfileInput = {
  /** Deployment region selected for tenant data. */
  region: string
  /** Locale used for tenant-owned defaults. */
  locale: TenantLocale
  /** Defaults applied to newly created tenant resources. */
  defaultPolicy: TenantDefaultPolicy
  /** Revision read before editing the profile. */
  expectedRevision: number
}

/**
 * Mutable governance fields accepted by the tenant administration API.
 */
export type UpdateTenantGovernanceInput = {
  /** Number of days audit records must be retained. */
  auditRetentionDays: number
  /** Whether deletion and retention expiry are suspended. */
  legalHold: boolean
  /** Region in which tenant data must remain. */
  dataResidency: string
  /** Encryption key ownership policy for tenant data. */
  encryptionKeyPolicy: 'aws-managed' | 'customer-managed'
  /** Revision read before editing the governance policy. */
  expectedRevision: number
}

/**
 * Tenant export request input.
 */
export type RequestTenantExportInput = {
  /** Export format requested by the tenant administrator. */
  format: 'jsonl' | 'csv'
}

/**
 * Account-closure request input.
 */
export type RequestTenantClosureInput = {
  /** Explicit confirmation phrase required to start closure. */
  confirmation: 'CLOSE'
}
