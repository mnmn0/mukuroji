import { describe, expect, test } from 'bun:test'
import {
  applyApprovedAiSearchToRouteState,
  applyApprovedAiSearchToRouteStateIfCurrent,
} from '../src/search/model/aiSearchApplication'
import {
  getSearchGroup,
  getSearchLayoutMode,
  parseSearchRouteState,
  serializeSearchRouteState,
} from '../src/search/model/queryState'

describe('approved AI Search application', () => {
  test('copies an approved grouped count intent into canonical Search query and layout state', () => {
    const currentState = parseSearchRouteState(new URLSearchParams('q=old&v=1'))
    const nextState = applyApprovedAiSearchToRouteState(currentState, {
      filters: { keyword: 'launch', teamIds: ['core-team'] },
      report: { groupBy: 'team', metric: 'count' },
    })
    const searchParams = serializeSearchRouteState(nextState)

    expect(searchParams.get('q')).toBe('launch')
    expect(searchParams.getAll('team')).toEqual(['core-team'])
    expect(searchParams.get('report')).toBe('count')
    expect(getSearchLayoutMode(nextState.layout)).toBe('board')
    expect(getSearchGroup(nextState.layout)).toBe('team')
  })

  test('clears an earlier report mode when the approved draft requests filters only', () => {
    const currentState = parseSearchRouteState(new URLSearchParams(
      'group=status&layout=board&report=count&v=1',
    ))
    const nextState = applyApprovedAiSearchToRouteState(currentState, {
      filters: { keyword: 'review' },
    })

    expect(nextState.reportMetric).toBeUndefined()
    expect(serializeSearchRouteState(nextState).has('report')).toBe(false)
  })

  /** Drops an approved AI application when navigation changes the reviewed route. */
  test('rejects applying an approved draft to a stale Search route', () => {
    const reviewedState = parseSearchRouteState(new URLSearchParams('q=old&v=1'))
    const currentState = parseSearchRouteState(new URLSearchParams('q=new&v=1'))

    const nextState = applyApprovedAiSearchToRouteStateIfCurrent(
      reviewedState,
      serializeSearchRouteState(reviewedState).toString(),
      serializeSearchRouteState(currentState).toString(),
      { filters: { keyword: 'approved' } },
    )

    expect(nextState).toBeUndefined()
  })

  /** Applies an approved AI application when the reviewed Search route remains current. */
  test('applies an approved draft when the Search route is unchanged', () => {
    const reviewedState = parseSearchRouteState(new URLSearchParams('q=old&v=1'))
    const signature = serializeSearchRouteState(reviewedState).toString()

    const nextState = applyApprovedAiSearchToRouteStateIfCurrent(
      reviewedState,
      signature,
      signature,
      { filters: { keyword: 'approved' } },
    )

    expect(nextState?.filters.keyword).toBe('approved')
  })
})
