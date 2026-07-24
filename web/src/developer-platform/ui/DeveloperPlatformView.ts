import type { ApiScope } from '@mukuroji/contracts'
import type { DeveloperConnectorCatalogItem } from '../model/connectors'
import type { DeveloperOAuthGrantType } from '../model/credentials'
import type { DeveloperWebhookEventType } from '../model/webhooks'

/**
 * Developer Platform panel section identifier.
 */
export type DeveloperPlatformSection =
  | 'credentials'
  | 'webhooks'
  | 'connectors'
  | 'imports'

/**
 * Value, label, and supporting description rendered by an input option.
 */
export type DeveloperPlatformOption<
  TValue extends string = string,
> = {
  /** Stable value passed to an action. */
  value: TValue
  /** User-facing option label. */
  label: string
  /** User-facing explanation of the option. */
  description: string
}

/**
 * Project option owned by an import destination Team.
 */
export type DeveloperImportProjectOption = DeveloperPlatformOption & {
  /** Identifier of the Team that owns the Project. */
  teamId: string
}

/**
 * One-time secret dialog kind.
 */
export type SecretDialogKind = 'api-key' | 'oauth-app' | 'webhook'

/**
 * Credential editor dialog kind.
 */
export type EditorDialogKind = 'api-key' | 'oauth-app' | 'webhook'

/**
 * Localized labels and display options used by Developer Platform UI.
 */
export type DeveloperPlatformLabels = {
  /** Panel eyebrow. */
  eyebrow: string
  /** Panel heading. */
  title: string
  /** Panel description. */
  description: string
  /** Badge shown when no mutation capability is available. */
  readOnly: string
  /** Screen-reader label for the loading state. */
  loading: string
  /** Message shown when aggregate resources cannot be loaded. */
  loadError: string
  /** Message shown when a mutation fails. */
  operationError: string
  /** Label for retrying aggregate resource loading. */
  retry: string
  /** Labels for each panel tab. */
  tabs: Record<DeveloperPlatformSection, string>
  /** Labels for entity status values. */
  statusLabels: Record<string, string>
  /** API scope options. */
  scopeOptions: DeveloperPlatformOption<ApiScope>[]
  /** OAuth grant type options. */
  grantTypeOptions: DeveloperPlatformOption<DeveloperOAuthGrantType>[]
  /** Webhook event type options. */
  webhookEventOptions: DeveloperPlatformOption<DeveloperWebhookEventType>[]
  /** Available connector catalog entries. */
  connectorCatalog: DeveloperConnectorCatalogItem[]
  /** Target Work Item field options used by import mapping. */
  importFieldOptions: DeveloperPlatformOption[]
  /** Table column labels keyed by column identifier. */
  tableHeaders: Record<string, string>
  /** Button and link labels keyed by action identifier. */
  actions: Record<string, string>
  /** Form field labels keyed by field identifier. */
  fields: Record<string, string>
  /** Input placeholders keyed by field identifier. */
  placeholders: Record<string, string>
  /** Section and empty-state headings keyed by identifier. */
  headings: Record<string, string>
  /** Section, empty-state, and security guidance text. */
  helpText: Record<string, string>
  /** Headings for each one-time secret kind. */
  secretTitles: Record<SecretDialogKind, string>
  /** Descriptions for each one-time secret kind. */
  secretDescriptions: Record<SecretDialogKind, string>
  /** Shared one-time secret warning. */
  secretWarning: string
  /** Confirmation label for safely storing a one-time secret. */
  secretStoredConfirmation: string
  /** Label for copying a secret. */
  copySecret: string
  /** Label shown after a secret is copied. */
  copiedSecret: string
  /** Label for closing a modal dialog. */
  closeDialog: string
  /** Placeholder-based summary shown for import reports. */
  importReportSummary: string
}
