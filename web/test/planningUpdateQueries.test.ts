import { describe, expect, test } from 'bun:test'
import type { PlanningUpdateReactionPage, PlanningUpdateTarget } from '@mukuroji/contracts'
import {
  deduplicatePlanningUpdateComments,
  hasPlanningUpdateViewerReaction,
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

  test('keeps comments with the same ID from different immutable versions', () => {
    const target = {
      type: 'project',
      projectId: 'refero',
      teamId: 'core-team',
    } satisfies PlanningUpdateTarget
    const comments = [1, 2].map((updateVersion) => ({
      authorMemberKey: 'author@example.com',
      body: `Comment ${updateVersion}`,
      createdAt: '2026-08-10T00:00:00.000Z',
      id: 'comment-reused-by-fixture',
      target,
      updateVersion,
    }))

    expect(deduplicatePlanningUpdateComments(comments)).toEqual(comments)
  })

  test('follows annotation cursors for twenty versions', async () => {
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
        const isFirstPage = input.cursor === undefined
        return {
          comments: [{
            authorMemberKey: 'author@example.com',
            body: `Comment ${input.updateVersion}-${isFirstPage ? 'first' : 'second'}`,
            createdAt: '2026-08-10T00:00:00.000Z',
            id: `comment-${input.updateVersion}-${isFirstPage ? 'first' : 'second'}`,
            target,
            updateVersion: input.updateVersion,
          }],
          ...(isFirstPage ? { nextCursor: `comment-page-2-${input.updateVersion}` } : {}),
        }
      },
      async (_accessToken, input) => {
        reactionRequests.push(input)
        const isFirstPage = input.cursor === undefined
        return {
          ...(isFirstPage ? { nextCursor: `reaction-page-2-${input.updateVersion}` } : {}),
          reactions: [{
            createdAt: '2026-08-10T00:00:00.000Z',
            emoji: '👍',
            memberKey: `${isFirstPage ? 'member' : 'other'}@example.com`,
            target,
            updateVersion: input.updateVersion,
          }],
        }
      },
    )

    expect(commentRequests).toHaveLength(40)
    expect(reactionRequests).toHaveLength(40)
    expect(commentRequests.map(({ updateVersion }) => updateVersion)).toEqual(
      [...versions.slice(0, 20), ...versions.slice(0, 20)],
    )
    expect(reactionRequests.map(({ updateVersion }) => updateVersion)).toEqual(
      [...versions.slice(0, 20), ...versions.slice(0, 20)],
    )
    expect(commentRequests.filter(({ cursor }) => cursor === undefined)).toHaveLength(20)
    expect(commentRequests.filter(({ cursor }) => cursor !== undefined)).toHaveLength(20)
    expect(reactionRequests.filter(({ cursor }) => cursor === undefined)).toHaveLength(20)
    expect(reactionRequests.filter(({ cursor }) => cursor !== undefined)).toHaveLength(20)
    expect(commentRequests.every(({ limit }) => limit === 100)).toBe(true)
    expect(reactionRequests.every(({ limit }) => limit === 100)).toBe(true)
    expect(annotations.comments).toHaveLength(40)
    expect(annotations.reactions).toHaveLength(40)
  })

  test('follows reaction pages until the viewer reaction is found', async () => {
    const target = { type: 'project' as const, teamId: 'team-1', projectId: 'project-1' }
    const calls: Array<{ cursor?: string }> = []
    const pages: PlanningUpdateReactionPage[] = [
      { reactions: [], nextCursor: 'page-2' },
      {
        reactions: [{
          target,
          updateVersion: 4,
          emoji: '👍',
          memberKey: ' Viewer@Example.com ',
          createdAt: '2026-08-11T00:00:00.000Z',
        }],
      },
    ]

    await expect(hasPlanningUpdateViewerReaction(
      'access-token',
      target,
      4,
      'viewer@example.com',
      '👍',
      async (_accessToken, input) => {
        calls.push({ cursor: input.cursor })
        const page = pages.shift()
        if (!page) throw new Error('unexpected reaction page')
        return page
      },
    )).resolves.toBe(true)

    expect(calls).toEqual([{ cursor: undefined }, { cursor: 'page-2' }])
  })
})
