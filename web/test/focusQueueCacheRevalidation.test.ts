import { describe, expect, test } from 'bun:test'
import {
  isFocusAffectedCacheKey,
  revalidateFocusCachesOnConflict,
  type FocusCacheRevalidationScope,
} from '../src/features/focus-queue/mutations/focusCacheRevalidation'
import { FocusQueueApiError } from '../src/features/focus-queue/api/focusQueue'
import { TeamIssuesApiError } from '../src/issues/api/errors'

describe('Focus cache revalidation', () => {
  test('matches loaded Workspace, Team, Project, and detail projections for one item', () => {
    const scope: FocusCacheRevalidationScope = {
      includePlanning: false,
      projectIds: ['project-a'],
      workItems: [{ teamId: 'team-a', workItemId: 'WI-1' }],
    }

    expect(isFocusAffectedCacheKey(['workspace-work-items', 'token'], scope)).toBe(true)
    expect(isFocusAffectedCacheKey(['team-issues', 'token', 'team-a'], scope)).toBe(true)
    expect(isFocusAffectedCacheKey([
      'project-relation-candidates',
      'token',
      'team-a',
    ], scope)).toBe(true)
    expect(isFocusAffectedCacheKey([
      'team-issue-detail',
      'token',
      'team-a',
      'WI-1',
    ], scope)).toBe(true)
    expect(isFocusAffectedCacheKey([
      'project-issue-detail',
      'token',
      'team-a',
      'WI-1',
    ], scope)).toBe(true)
    expect(isFocusAffectedCacheKey(['project-issues', 'token', 'project-a'], scope)).toBe(true)

    expect(isFocusAffectedCacheKey(['team-issues', 'token', 'team-b'], scope)).toBe(false)
    expect(isFocusAffectedCacheKey([
      'team-issue-detail',
      'token',
      'team-a',
      'WI-2',
    ], scope)).toBe(false)
    expect(isFocusAffectedCacheKey(['project-issues', 'token', 'project-b'], scope)).toBe(false)
    expect(isFocusAffectedCacheKey(['planning-snapshot', 'token'], scope)).toBe(false)
    expect(isFocusAffectedCacheKey('workspace-work-items', scope)).toBe(false)
    expect(isFocusAffectedCacheKey(() => ['workspace-work-items'], scope)).toBe(false)
  })

  test('includes every propagated schedule impact and the Planning snapshot', () => {
    const scope: FocusCacheRevalidationScope = {
      includePlanning: true,
      projectIds: ['project-a', 'project-b'],
      workItems: [
        { teamId: 'team-a', workItemId: 'WI-1' },
        { teamId: 'team-b', workItemId: 'WI-2' },
      ],
    }

    expect(isFocusAffectedCacheKey(['planning-snapshot', 'token'], scope)).toBe(true)
    expect(isFocusAffectedCacheKey(['team-issues', 'token', 'team-b'], scope)).toBe(true)
    expect(isFocusAffectedCacheKey([
      'team-issue-detail',
      'token',
      'team-b',
      'WI-2',
    ], scope)).toBe(true)
    expect(isFocusAffectedCacheKey(['project-issues', 'token', 'project-b'], scope)).toBe(true)
  })

  test('immediately revalidates either Focus or Work Item conflicts only', async () => {
    let revalidationCount = 0
    const revalidate = async () => {
      revalidationCount += 1
    }

    await revalidateFocusCachesOnConflict(
      new FocusQueueApiError(409, 'Focus conflict'),
      revalidate,
    )
    await revalidateFocusCachesOnConflict(
      new TeamIssuesApiError(409, 'Work Item conflict'),
      revalidate,
    )
    await revalidateFocusCachesOnConflict(
      new TeamIssuesApiError(500, 'Work Item failure'),
      revalidate,
    )
    await revalidateFocusCachesOnConflict(
      new FocusQueueApiError(500, 'Focus failure'),
      revalidate,
    )

    expect(revalidationCount).toBe(2)
  })
})
