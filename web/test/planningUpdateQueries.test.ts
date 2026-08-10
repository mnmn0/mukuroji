import { describe, expect, test } from 'bun:test'
import type { PlanningUpdateTarget } from '@mukuroji/contracts'
import {
  loadBoundedPlanningUpdateAnnotations,
  revalidatePlanningUpdateHistoryAfterPublish,
  selectPlanningUpdateAnnotationVersions,
} from '../src/planning/queries/usePlanningUpdates'

describe('Planning update query coordination', () => {
  test('does not turn a post-publish history refresh failure into a publish failure', async () => {
    expect(await revalidatePlanningUpdateHistoryAfterPublish(
      async () => { throw new Error('history unavailable') },
    )).toBe(false)
    expect(await revalidatePlanningUpdateHistoryAfterPublish(
      async () => undefined,
    )).toBe(true)
  })

  test('selects at most the newest twenty distinct update versions', () => {
    const updates = [
      { version: 25 },
      { version: 25 },
      ...Array.from({ length: 24 }, (_, index) => ({ version: 24 - index })),
    ]

    expect(selectPlanningUpdateAnnotationVersions(updates)).toEqual(
      Array.from({ length: 20 }, (_, index) => 25 - index),
    )
  })

  test('loads only the first bounded annotation page for twenty versions', async () => {
    const target = {
      type: 'project',
      projectId: 'refero',
      teamId: 'core-team',
    } satisfies PlanningUpdateTarget
    const commentRequests: Array<{ cursor?: string; limit?: number; updateVersion: number }> = []
    const reactionRequests: Array<{ cursor?: string; limit?: number; updateVersion: number }> = []
    const versions = Array.from({ length: 25 }, (_, index) => 25 - index)

    const annotations = await loadBoundedPlanningUpdateAnnotations(
      'access-token',
      target,
      versions,
      async (_accessToken, input) => {
        commentRequests.push(input)
        return {
          comments: [{
            authorMemberKey: 'author@example.com',
            body: `Comment ${input.updateVersion}`,
            createdAt: '2026-08-10T00:00:00.000Z',
            id: `comment-${input.updateVersion}`,
            target,
            updateVersion: input.updateVersion,
          }],
          nextCursor: `comment-page-2-${input.updateVersion}`,
        }
      },
      async (_accessToken, input) => {
        reactionRequests.push(input)
        return {
          nextCursor: `reaction-page-2-${input.updateVersion}`,
          reactions: [{
            createdAt: '2026-08-10T00:00:00.000Z',
            emoji: '👍',
            memberKey: 'member@example.com',
            target,
            updateVersion: input.updateVersion,
          }],
        }
      },
    )

    expect(commentRequests).toHaveLength(20)
    expect(reactionRequests).toHaveLength(20)
    expect(commentRequests.map(({ updateVersion }) => updateVersion)).toEqual(
      versions.slice(0, 20),
    )
    expect(reactionRequests.map(({ updateVersion }) => updateVersion)).toEqual(
      versions.slice(0, 20),
    )
    expect(commentRequests.every(({ cursor, limit }) => cursor === undefined && limit === 100)).toBe(true)
    expect(reactionRequests.every(({ cursor, limit }) => cursor === undefined && limit === 100)).toBe(true)
    expect(annotations.comments).toHaveLength(20)
    expect(annotations.reactions).toHaveLength(20)
  })
})
