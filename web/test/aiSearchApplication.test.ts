import { describe, expect, test } from 'bun:test'
import {
  applyApprovedAiSearchToRouteState,
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
})
