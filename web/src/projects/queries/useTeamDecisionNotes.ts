import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import useSWR from 'swr'
import { searchWorkspace } from '../../search/api/search'

/** Most decision notes the Team decision log shows. */
const DECISION_NOTE_LIMIT = 50

/** Most search pages read while collecting decision notes. */
const DECISION_NOTE_PAGE_LIMIT = 5

/** Search results read per page. */
const DECISION_NOTE_PAGE_SIZE = 50

/** Decision notes of a Team, as far as the search pages read reach. */
export type TeamDecisionNotes = {
  /** Decision notes, in search order. */
  notes: WorkspaceSearchResult[]
  /** Whether more matching context items may exist beyond the pages read. */
  truncated: boolean
}

/** Filters of the decision note lookup. */
export type TeamDecisionNoteFilters = {
  /** Keyword the notes must match; empty matches every note. */
  keyword: string
  /** Project the notes must belong to; empty means every Project. */
  projectId: string
}

/**
 * Collects the decision notes kept on a Team's Work Items. Workspace search returns curated
 * context items of every kind, so the lookup follows search cursors until it has enough decision
 * notes, the search ends, or the page limit is reached, and says when it stopped early.
 *
 * @param accessToken - Bearer token for Workspace search.
 * @param teamId - Team whose notes are read.
 * @param filters - Keyword and Project filters.
 * @returns The collected notes and whether the list stopped early.
 */
export async function loadTeamDecisionNotes(
  accessToken: string,
  teamId: string,
  filters: TeamDecisionNoteFilters,
): Promise<TeamDecisionNotes> {
  const notes: WorkspaceSearchResult[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < DECISION_NOTE_PAGE_LIMIT; page += 1) {
    const response = await searchWorkspace(accessToken, {
      entityTypes: ['context-item'],
      teamIds: [teamId],
      ...(filters.keyword ? { keyword: filters.keyword } : {}),
      ...(filters.projectId ? { projectIds: [filters.projectId] } : {}),
    }, { limit: DECISION_NOTE_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    // Curated context items carry their kind as the subtitle.
    notes.push(...response.results.filter((result) => result.subtitle === 'decision'))
    const nextCursor = response.nextCursor
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return { notes: notes.slice(0, DECISION_NOTE_LIMIT), truncated: notes.length > DECISION_NOTE_LIMIT }
    }
    if (notes.length >= DECISION_NOTE_LIMIT) {
      return { notes: notes.slice(0, DECISION_NOTE_LIMIT), truncated: true }
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
  return { notes: notes.slice(0, DECISION_NOTE_LIMIT), truncated: true }
}

/**
 * Reads the decision notes kept on a Team's Work Items.
 *
 * @param accessToken - Bearer token; nothing loads without it.
 * @param teamId - Team whose notes are read.
 * @param filters - Keyword and Project filters.
 * @returns SWR state of the notes.
 */
export function useTeamDecisionNotes(
  accessToken: string | undefined,
  teamId: string,
  filters: TeamDecisionNoteFilters,
) {
  return useSWR(
    accessToken ? ['team-decision-notes', accessToken, teamId, filters.keyword, filters.projectId] as const : null,
    ([, token, currentTeamId, keyword, projectId]) => loadTeamDecisionNotes(token, currentTeamId, { keyword, projectId }),
    { shouldRetryOnError: false, keepPreviousData: true },
  )
}
