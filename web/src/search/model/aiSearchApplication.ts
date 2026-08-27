import type {
  AiSearchReportDraft,
  SearchViewLayout,
  WorkspaceSearchFilters,
} from '@mukuroji/contracts'
import { updateSearchRouteState, type SearchRouteState } from './queryState'

/** Reviewed AI Search values that may be applied only after approval succeeds. */
export type ApprovedAiSearchApplication = {
  /** Operator-reviewed filters copied into the existing Search route state. */
  filters: WorkspaceSearchFilters
  /** Approved bounded count intent rendered from permission-filtered Search results. */
  report?: AiSearchReportDraft
}

/**
 * Applies approved AI filters and report presentation to the existing Search route state.
 *
 * A grouped report uses the existing board grouping so the loaded result buckets remain
 * inspectable. The count metric itself is persisted in the canonical URL state.
 *
 * @param state - Current Search route state.
 * @param application - Values returned only after the human approval decision succeeds.
 * @returns The next canonical Search route state.
 */
export function applyApprovedAiSearchToRouteState(
  state: SearchRouteState,
  application: ApprovedAiSearchApplication,
): SearchRouteState {
  const groupBy = application.report?.groupBy
  const layout: SearchViewLayout = application.report
    ? groupBy
      ? {
          ...state.layout,
          groupBy,
          mode: 'board',
        }
      : {
          ...state.layout,
          groupBy: undefined,
        }
    : state.layout

  return updateSearchRouteState(state, {
    filters: application.filters,
    layout,
    reportMetric: application.report?.metric,
  })
}

/**
 * Applies an approved AI Search result only when the route reviewed by the operator is still current.
 *
 * @param state - Route state captured when the approval interaction began.
 * @param expectedRouteSignature - Canonical signature captured for that interaction.
 * @param currentRouteSignature - Latest canonical signature at completion time.
 * @param application - Values returned only after the human approval decision succeeds.
 * @returns The next route state, or undefined when navigation made the review stale.
 */
export function applyApprovedAiSearchToRouteStateIfCurrent(
  state: SearchRouteState,
  expectedRouteSignature: string,
  currentRouteSignature: string,
  application: ApprovedAiSearchApplication,
): SearchRouteState | undefined {
  if (expectedRouteSignature !== currentRouteSignature) return undefined
  return applyApprovedAiSearchToRouteState(state, application)
}
