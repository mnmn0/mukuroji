import type {
  TriageEntryState,
  TriageQueueFilters,
  TriageSlaFilter,
  TriageSourceKind,
} from '../api'

/** Top-level surface selected inside the Team triage route. */
export type TriageRouteView = 'queue' | 'settings'

/** URL-backed state owned by the Team triage page. */
export type TriageRouteState = {
  /** Selected queue entry displayed in the detail pane. */
  readonly entryId?: string
  /** Selected queue or settings surface. */
  readonly view: TriageRouteView
  /** Queue filters represented in the URL. */
  readonly filters: TriageQueueFilters
}

/**
 * Parses supported Team triage state from URL search parameters.
 *
 * @param searchParams - Current route search parameters.
 * @returns Normalized Team triage route state.
 */
export function readTriageRouteState(searchParams: URLSearchParams): TriageRouteState {
  const entryId = readTrimmed(searchParams.get('entryId'))
  const query = readTrimmed(searchParams.get('q'))
  const state = readEntryState(searchParams.get('state'))
  const source = readSourceKind(searchParams.get('source'))
  const owner = readOwnerFilter(searchParams.get('owner'))
  const sla = readSlaFilter(searchParams.get('sla'))

  return {
    filters: {
      ...(owner ? { owner } : {}),
      ...(query ? { query } : {}),
      ...(sla ? { sla } : {}),
      ...(source ? { source } : {}),
      ...(state ? { state } : {}),
    },
    view: searchParams.get('view') === 'settings' ? 'settings' : 'queue',
    ...(entryId ? { entryId } : {}),
  }
}

/**
 * Serializes Team triage route state without retaining unsupported parameters.
 *
 * @param state - Normalized Team triage route state.
 * @returns Search parameters suitable for React Router navigation.
 */
export function createTriageSearchParams(state: TriageRouteState) {
  const searchParams = new URLSearchParams()
  if (state.view === 'settings') searchParams.set('view', 'settings')
  if (state.entryId && state.view === 'queue') searchParams.set('entryId', state.entryId)
  if (state.filters.query) searchParams.set('q', state.filters.query)
  if (state.filters.state) searchParams.set('state', state.filters.state)
  if (state.filters.source) searchParams.set('source', state.filters.source)
  if (state.filters.owner && state.filters.owner !== 'all') {
    searchParams.set('owner', state.filters.owner)
  }
  if (state.filters.sla) searchParams.set('sla', state.filters.sla)
  return searchParams
}

/** Normalizes a nullable URL value to a non-empty string. */
function readTrimmed(value: string | null) {
  return value?.trim() || undefined
}

/** Narrows a URL value to a supported entry state. */
function readEntryState(value: string | null): TriageEntryState | undefined {
  return value === 'pending' || value === 'accepted' || value === 'duplicate' ||
    value === 'declined' || value === 'snoozed' || value === 'needs-information'
    ? value
    : undefined
}

/** Narrows a URL value to a supported source kind. */
function readSourceKind(value: string | null): TriageSourceKind | undefined {
  return value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff'
    ? value
    : undefined
}

/** Narrows a URL value to a non-default owner filter. */
function readOwnerFilter(value: string | null): TriageQueueFilters['owner'] {
  return value === 'mine' || value === 'unowned' ? value : undefined
}

/** Narrows a URL value to a supported SLA filter. */
function readSlaFilter(value: string | null): TriageSlaFilter | undefined {
  return value === 'on-track' || value === 'due-soon' || value === 'breached' || value === 'paused'
    ? value
    : undefined
}
