import { afterEach, describe, expect, test } from 'bun:test'
import { mutate } from 'swr'
import type { CanonicalWorkItem, WorkItemScheduleChangePreview } from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../src/shared/api/mutationHeaders'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createWorkItemListScheduleMutations } from '../src/tasks/mutations/createWorkItemListScheduleMutations'
import {
  createDefaultDueDateTaskSchedule,
  createMoveTaskScheduleOperation,
} from '../src/tasks/model/taskSchedule'

const [fixture] = referoTaskFixtures
if (!fixture) throw new Error('Expected a task fixture.')
const task: CanonicalWorkItem = {
  ...fixture,
  dueDate: '2026-06-03',
  schedule: createDefaultDueDateTaskSchedule('2026-06-03'),
}
const confirmedSchedule = {
  dueDate: '2026-06-05',
  id: task.id,
  revision: task.revision + 1,
  schedule: createDefaultDueDateTaskSchedule('2026-06-05'),
  teamId: task.teamId,
}
const preview: WorkItemScheduleChangePreview = {
  affectedMilestoneIds: [],
  affectedProjects: [],
  conflicts: [],
  evaluatedRevisions: [{ expectedRevision: task.revision, teamId: task.teamId, workItemId: task.id }],
  expectedRevision: task.revision,
  impacts: [],
  planningRevision: 3,
  relationGraphRevision: 2,
  requiresConfirmation: true,
  warnings: [],
}
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Work Item list schedule confirmation', () => {
  test('retries a failed or stale list read and publishes the list that shows the commit', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ workItems: [confirmedSchedule] }),
      { preconnect: originalFetch.preconnect },
    )
    const cacheKey = `work-item-list-schedule:${crypto.randomUUID()}`
    await mutate(cacheKey, [task], { revalidate: false })
    const observedErrors: unknown[] = []
    let readCount = 0
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })

    const mutations = createWorkItemListScheduleMutations({
      accessToken: 'token',
      guardEnterpriseSession: (request) => request,
      mutateCache: mutate,
      mutationRequestRunner: createMutationRequestRunner(),
      onBackgroundRefreshError: (error) => {
        observedErrors.push(error)
      },
      readTasks: async () => {
        readCount += 1
        if (readCount === 1) throw new Error('Transient list GET failure.')
        if (readCount === 2) return [task]
        resolveSettled()
        return [{ ...task, revision: confirmedSchedule.revision, dueDate: '2026-06-05', title: 'Read' }]
      },
      t: createTranslator('en'),
      tasksCacheKey: cacheKey,
    })

    const confirmed = await mutations.confirmScheduleChange(
      task,
      createMoveTaskScheduleOperation('2026-06-05'),
      preview,
    )
    expect(confirmed.revision).toBe(confirmedSchedule.revision)
    await settled
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(readCount).toBe(3)
    expect(observedErrors).toEqual([])
    const published = await mutate<CanonicalWorkItem[]>(cacheKey)
    expect(published?.[0]?.title).toBe('Read')
    expect(published?.[0]?.revision).toBe(confirmedSchedule.revision)
  })

  test('keeps a newer cached revision that a slower refresh would roll back', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ workItems: [confirmedSchedule] }),
      { preconnect: originalFetch.preconnect },
    )
    const cacheKey = `work-item-list-schedule:${crypto.randomUUID()}`
    await mutate(cacheKey, [task], { revalidate: false })
    const newer = { ...task, revision: confirmedSchedule.revision + 1, title: 'Second commit' }
    let resolveRead: () => void = () => undefined
    const readDone = new Promise<void>((resolve) => {
      resolveRead = resolve
    })

    const mutations = createWorkItemListScheduleMutations({
      accessToken: 'token',
      guardEnterpriseSession: (request) => request,
      mutateCache: mutate,
      mutationRequestRunner: createMutationRequestRunner(),
      onBackgroundRefreshError: () => undefined,
      readTasks: async () => {
        // A second confirmation commits while this read is in flight.
        await mutate(cacheKey, [newer], { revalidate: false })
        resolveRead()
        return [{ ...task, revision: confirmedSchedule.revision }]
      },
      t: createTranslator('en'),
      tasksCacheKey: cacheKey,
    })

    await mutations.confirmScheduleChange(task, createMoveTaskScheduleOperation('2026-06-05'), preview)
    await readDone
    await new Promise((resolve) => setTimeout(resolve, 0))
    const published = await mutate<CanonicalWorkItem[]>(cacheKey)
    expect(published?.[0]?.revision).toBe(newer.revision)
    expect(published?.[0]?.title).toBe('Second commit')
  })

  test('reports a list read that keeps failing', async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ workItems: [confirmedSchedule] }),
      { preconnect: originalFetch.preconnect },
    )
    const cacheKey = `work-item-list-schedule:${crypto.randomUUID()}`
    await mutate(cacheKey, [task], { revalidate: false })
    const failure = new Error('List GET failed.')
    let resolveReported: (error: unknown) => void = () => undefined
    const reported = new Promise<unknown>((resolve) => {
      resolveReported = resolve
    })

    const mutations = createWorkItemListScheduleMutations({
      accessToken: 'token',
      guardEnterpriseSession: (request) => request,
      mutateCache: mutate,
      mutationRequestRunner: createMutationRequestRunner(),
      onBackgroundRefreshError: (error) => resolveReported(error),
      readTasks: async () => {
        throw failure
      },
      t: createTranslator('en'),
      tasksCacheKey: cacheKey,
    })

    await mutations.confirmScheduleChange(task, createMoveTaskScheduleOperation('2026-06-05'), preview)
    await expect(reported).resolves.toBe(failure)
    // The committed schedule stays in the list although every read failed.
    const published = await mutate<CanonicalWorkItem[]>(cacheKey)
    expect(published?.[0]?.revision).toBe(confirmedSchedule.revision)
  })
})
