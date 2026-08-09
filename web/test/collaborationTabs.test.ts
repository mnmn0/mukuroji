import { describe, expect, test } from 'bun:test'
import {
  applyIssueCollaborationTabToSearchParams,
  applyIssueCollaborationSourceToSearchParams,
  getIssueCollaborationSearchParamsToClear,
  issueCollaborationTargetSearchParams,
  issueCollaborationTabs,
  readIssueCollaborationTab,
  resolveIssueCollaborationTab,
  resolveIssueCollaborationTabTarget,
} from '../src/issues/model/collaborationTabs'

describe('issue collaboration tabs', () => {
  test('keeps the stable panel order', () => {
    expect(issueCollaborationTabs).toEqual([
      'conversation',
      'decisions',
      'activity',
      'sources',
    ])
  })

  test('accepts supported URL state and falls back to conversation', () => {
    expect(readIssueCollaborationTab('decisions')).toBe('decisions')
    expect(readIssueCollaborationTab('activity')).toBe('activity')
    expect(readIssueCollaborationTab('sources')).toBe('sources')
    expect(readIssueCollaborationTab('unknown')).toBe('conversation')
    expect(readIssueCollaborationTab(null)).toBe('conversation')
    expect(readIssueCollaborationTab(undefined)).toBe('conversation')
  })

  test('prioritizes explicit tab state over deep-link targets', () => {
    expect(
      resolveIssueCollaborationTab({
        requestedTab: 'activity',
        focusedContextItemId: 'context-1',
        focusedSourceId: 'source-1',
      }),
    ).toBe('activity')
    expect(
      resolveIssueCollaborationTab({ focusedContextItemId: 'context-1' }),
    ).toBe('decisions')
    expect(resolveIssueCollaborationTab({ focusedSourceId: 'source-1' })).toBe(
      'sources',
    )
    expect(
      resolveIssueCollaborationTab({ focusedActivityEventId: 'event-1' }),
    ).toBe('activity')
  })

  test('updates tab state and clears targets owned by other sections', () => {
    const current = new URLSearchParams(
      'collaborationTab=sources&contextItemId=context-1&sourceId=source-1&sourceKind=document&activityEventId=event-1',
    )
    const next = applyIssueCollaborationTabToSearchParams(current, 'activity')

    expect(next.get('collaborationTab')).toBe('activity')
    expect(next.get('activityEventId')).toBe('event-1')
    expect(next.get('contextItemId')).toBeNull()
    expect(next.get('sourceId')).toBeNull()
    expect(next.get('sourceKind')).toBeNull()

    expect(
      applyIssueCollaborationTabToSearchParams(current, 'conversation').get(
        'collaborationTab',
      ),
    ).toBeNull()
  })

  test('wraps arrow navigation and supports Home and End', () => {
    expect(
      resolveIssueCollaborationTabTarget(
        'conversation',
        'ArrowLeft',
        issueCollaborationTabs,
      ),
    ).toBe('sources')
    expect(
      resolveIssueCollaborationTabTarget(
        'sources',
        'ArrowRight',
        issueCollaborationTabs,
      ),
    ).toBe('conversation')
    expect(
      resolveIssueCollaborationTabTarget(
        'activity',
        'Home',
        issueCollaborationTabs,
      ),
    ).toBe('conversation')
    expect(
      resolveIssueCollaborationTabTarget(
        'decisions',
        'End',
        issueCollaborationTabs,
      ),
    ).toBe('sources')
  })

  test('uses the rendered tab order when a subset is visible', () => {
    expect(
      resolveIssueCollaborationTabTarget('conversation', 'ArrowRight', [
        'conversation',
        'activity',
      ]),
    ).toBe('activity')
    expect(
      resolveIssueCollaborationTabTarget('activity', 'ArrowRight', [
        'conversation',
        'activity',
      ]),
    ).toBe('conversation')
  })

  test('ignores unrelated keys and missing current tabs', () => {
    expect(
      resolveIssueCollaborationTabTarget(
        'decisions',
        'Enter',
        issueCollaborationTabs,
      ),
    ).toBeUndefined()
    expect(
      resolveIssueCollaborationTabTarget('decisions', 'ArrowRight', [
        'conversation',
      ]),
    ).toBeUndefined()
    expect(
      resolveIssueCollaborationTabTarget('conversation', 'ArrowRight', []),
    ).toBeUndefined()
  })

  test('clears source identity and kind together outside the Sources tab', () => {
    expect(getIssueCollaborationSearchParamsToClear('activity')).toEqual(
      expect.arrayContaining(['sourceId', 'sourceKind']),
    )
    expect(getIssueCollaborationSearchParamsToClear('sources')).not.toContain(
      'sourceId',
    )
    expect(getIssueCollaborationSearchParamsToClear('sources')).not.toContain(
      'sourceKind',
    )
    expect(issueCollaborationTargetSearchParams).toEqual(
      expect.arrayContaining(['sourceId', 'sourceKind']),
    )
  })

  test('persists an exact source target without dropping the Work Item route', () => {
    const current = new URLSearchParams(
      'teamId=core-team&issueId=issue-1&commentId=comment-1&rootCommentId=root-1',
    )
    const next = applyIssueCollaborationSourceToSearchParams(current, {
      contextItemId: 'context-1',
      kind: 'comment',
      sourceId: 'comment-2',
    })

    expect(next.get('teamId')).toBe('core-team')
    expect(next.get('issueId')).toBe('issue-1')
    expect(next.get('collaborationTab')).toBe('sources')
    expect(next.get('contextItemId')).toBe('context-1')
    expect(next.get('sourceId')).toBe('comment-2')
    expect(next.get('sourceKind')).toBe('comment')
    expect(next.get('commentId')).toBeNull()
    expect(next.get('rootCommentId')).toBeNull()
  })
})
