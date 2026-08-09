import { describe, expect, test } from 'bun:test'
import {
  issueCollaborationTabs,
  readIssueCollaborationTab,
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
})
