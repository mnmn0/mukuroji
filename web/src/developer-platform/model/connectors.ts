import type {
  ConnectorInstallation,
  CursorPage,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import { formatConnectorProviderName } from './displayFormatting'

/**
 * Connector provider identifier.
 */
export type DeveloperConnectorProvider = ConnectorInstallation['provider']

/**
 * Connector catalog entry rendered even when the provider is disconnected.
 */
export type DeveloperConnectorCatalogItem = {
  /** Provider identifier used by connector actions. */
  provider: DeveloperConnectorProvider
  /** User-facing connector name. */
  name: string
  /** Description of resources synchronized by the connector. */
  description: string
  /** User-facing connector category label. */
  categoryLabel: string
  /** Scopes requested for a new installation. */
  scopes: string[]
  /** Additional terms matched by connector search. */
  searchTerms: string[]
}

/**
 * Input used to start a connector authorization flow.
 */
export type ConnectDeveloperConnectorInput = {
  /** Human-readable installation name. */
  name: string
  /** Provider scopes granted to the installation. */
  scopes: string[]
  /** Optional application-relative return URL after authorization. */
  returnUrl?: string
}

/**
 * Supported resolution for a work-item synchronization conflict.
 */
export type DeveloperSyncConflictResolution =
  | 'keep-local'
  | 'keep-remote'
  | 'merge'
  | 'ignore'

/**
 * Input used to resolve a work-item synchronization conflict.
 */
export type ResolveDeveloperSyncConflictInput = {
  /** Identifier of the conflict being resolved. */
  conflictId: string
  /** Resolution selected by the user. */
  resolution: DeveloperSyncConflictResolution
  /** Optional field values supplied for a merge resolution. */
  mergedValues?: Record<string, unknown>
}

/**
 * Checks whether an unknown value is a supported conflict resolution.
 *
 * @param value - Candidate value from a UI control or external boundary.
 * @returns Whether the value is a supported resolution.
 */
export function isDeveloperSyncConflictResolution(
  value: unknown,
): value is DeveloperSyncConflictResolution {
  return (
    value === 'keep-local' ||
    value === 'keep-remote' ||
    value === 'merge' ||
    value === 'ignore'
  )
}

/**
 * Adds installed providers that are missing from the localized catalog.
 *
 * @param catalog - Localized connector catalog entries.
 * @param installations - Current connector installations.
 * @param installedConnectorDescription - Description used for synthesized entries.
 * @returns A complete catalog with one entry per installed provider.
 */
export function completeDeveloperConnectorCatalog(
  catalog: DeveloperConnectorCatalogItem[],
  installations: ConnectorInstallation[],
  installedConnectorDescription: string,
) {
  return [
    ...catalog,
    ...installations
      .filter(
        (installation, index, currentInstallations) =>
          !catalog.some(
            (item) => item.provider === installation.provider,
          ) &&
          currentInstallations.findIndex(
            (item) => item.provider === installation.provider,
          ) === index,
      )
      .map((installation) => ({
        provider: installation.provider,
        name: formatConnectorProviderName(installation.provider),
        description: installedConnectorDescription,
        categoryLabel: formatConnectorProviderName(installation.category),
        scopes: installation.scopes,
        searchTerms: [installation.provider, installation.category],
      })),
  ]
}

/**
 * Filters connector catalog entries and their accounts by a search query.
 *
 * @param catalog - Complete connector catalog.
 * @param installations - Current connector installations.
 * @param query - User-entered search query.
 * @returns Catalog entries matching provider or account metadata.
 */
export function filterDeveloperConnectorCatalog(
  catalog: DeveloperConnectorCatalogItem[],
  installations: ConnectorInstallation[],
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase()

  if (!normalizedQuery) {
    return catalog
  }

  return catalog.filter((item) => {
    const providerInstallations = installations.filter(
      (installation) => installation.provider === item.provider,
    )
    const haystack = [
      item.name,
      item.description,
      item.categoryLabel,
      ...item.searchTerms,
      ...providerInstallations.flatMap((installation) => [
        installation.name,
        installation.externalAccountName,
        installation.externalAccountId,
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()

    return haystack.includes(normalizedQuery)
  })
}

/**
 * Flattens paginated synchronization conflicts and removes duplicate IDs.
 *
 * @param pages - Loaded conflict pages, if any.
 * @returns Conflicts in page order with duplicate IDs removed.
 */
export function flattenDeveloperSyncConflicts(
  pages?: Array<{ items: WorkItemSyncConflict[] }>,
) {
  const items = pages?.flatMap((page) => page.items) ?? []

  return [...new Map(items.map((item) => [item.id, item])).values()]
}

/**
 * Replaces a resolved conflict in every loaded cache page.
 *
 * @param pages - Currently cached synchronization-conflict pages.
 * @param resolvedConflict - Authoritative conflict returned by the mutation.
 * @returns Cache pages with every matching conflict replaced.
 */
export function replaceResolvedSyncConflictPages(
  pages: CursorPage<WorkItemSyncConflict>[] | undefined,
  resolvedConflict: WorkItemSyncConflict,
) {
  return pages?.map((page) => ({
    ...page,
    items: page.items.map((conflict) =>
      conflict.id === resolvedConflict.id
        ? resolvedConflict
        : conflict,
    ),
  }))
}

/**
 * Formats a conflict value for a human-readable comparison.
 *
 * @param value - Conflict field value.
 * @param fallback - Text used when the value cannot be represented.
 * @returns A readable string representation.
 */
export function formatSyncConflictValue(
  value: unknown,
  fallback: string,
) {
  if (typeof value === 'string') {
    return value === '' ? '""' : value
  }

  if (value === undefined) {
    return fallback
  }

  try {
    return JSON.stringify(value, null, 2) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Formats a conflict value as an editable JSON merge draft.
 *
 * @param value - Local field value used to seed the draft.
 * @returns JSON text suitable for the merge editor.
 */
export function formatConflictMergeDraft(value: unknown) {
  if (value === undefined) {
    return 'null'
  }

  return JSON.stringify(value, null, 2) ?? 'null'
}

/**
 * Parses merge drafts into the field-value record accepted by the resolver.
 *
 * @param conflict - Conflict whose fields define the merge payload.
 * @param drafts - Optional edited JSON drafts keyed by field name.
 * @returns Parsed merge values keyed by field name.
 * @throws {SyntaxError} When a draft is not valid JSON.
 */
export function parseConflictMergedValues(
  conflict: WorkItemSyncConflict,
  drafts?: Record<string, string>,
) {
  return Object.fromEntries(
    conflict.fields.map((field) => [
      field.field,
      parseJsonValue(
        drafts?.[field.field] ??
          formatConflictMergeDraft(field.localValue),
      ),
    ]),
  )
}

/**
 * Parses JSON text while keeping the boundary value unknown.
 *
 * @param value - JSON text to parse.
 * @returns Parsed JSON value.
 */
function parseJsonValue(value: string): unknown {
  return JSON.parse(value)
}
