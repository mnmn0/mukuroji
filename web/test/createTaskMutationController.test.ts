import { afterEach, describe, expect, test } from 'bun:test'
import type { KeyedMutator } from 'swr'
import type { CanonicalWorkItem, CreateWorkItemInput } from '../src/tasks/api/tasks'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { createMutationRequestRunner } from '../src/shared/api/mutationHeaders'
import { createTaskMutationController } from '../src/tasks/mutations/createTaskMutationController'
import { createDefaultUnscheduledTaskSchedule } from '../src/tasks/model/taskSchedule'

const originalFetch = globalThis.fetch

const createInput = {
  assigneeUserId: 'sato@example.com',
  priority: 'medium',
  schedule: createDefaultUnscheduledTaskSchedule(),
  title: '作成した Work Item',
} satisfies CreateWorkItemInput

/** Builds a canonical fixture with a stable Project and Team scope for controller tests. */
function createFixtureTask(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return {
    ...referoTaskFixtures[0],
    ...overrides,
    assignedProjectId: 'refero',
    teamId: 'core-team',
  }
}

/** Returns a successful JSON response for the mocked create endpoint. */
function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 201,
  })
}

/**
 * Creates a controller and records every cache phase for one confirmed create.
 *
 * @param onCreated - Optional callback that simulates the page notification after confirmation.
 */
function createControllerHarness(
  createdTask: CanonicalWorkItem,
  initialTasks: CanonicalWorkItem[],
  refreshedTasks: CanonicalWorkItem[],
  refreshCacheTasks: CanonicalWorkItem[] = refreshedTasks,
  onCreated?: (task: CanonicalWorkItem) => void,
) {
  let currentTasks = initialTasks
  let firstUpdaterResult: CanonicalWorkItem[] | undefined
  let postCount = 0

  globalThis.fetch = async (_input, init) => {
    if (init?.method !== 'POST') throw new Error('Unexpected non-create request')
    postCount += 1
    return createJsonResponse({ issue: createdTask })
  }

  const mutateProjectTasks: KeyedMutator<CanonicalWorkItem[]> = async (data) => {
    if (typeof data === 'function') {
      const nextTasks = await data(currentTasks)
      if (nextTasks !== undefined) currentTasks = nextTasks
      firstUpdaterResult ??= currentTasks
      return currentTasks
    }
    if (data === undefined) {
      currentTasks = refreshCacheTasks
      return refreshedTasks
    }
    const nextTasks = await data
    if (nextTasks !== undefined) currentTasks = nextTasks
    return currentTasks
  }

  const controller = createTaskMutationController({
    accessToken: 'test-token',
    createErrorMessage: 'create failed',
    guardEnterpriseSession: async <Result>(request: Promise<Result>) => request,
    mutateProjectTasks,
    mutationRequestRunner: createMutationRequestRunner(() => ({
      correlationId: 'correlation-test',
      idempotencyKey: 'idempotency-test',
    })),
    onCreated,
    projectId: 'refero',
  })

  return {
    controller,
    /** Returns the cache state after the controller completes. */
    get currentTasks() {
      return currentTasks
    },
    /** Returns the cache state produced by the initial confirmed-create updater. */
    get firstUpdaterResult() {
      return firstUpdaterResult
    },
    /** Returns the number of create POST requests observed by the harness. */
    get postCount() {
      return postCount
    },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('create Task mutation controller', () => {
  test('preserves a newer cached revision when the confirmed POST is older', async () => {
    const createdTask = createFixtureTask({
      id: 'retry-existing',
      revision: 1,
      title: '古い POST 結果',
    })
    const cachedTask = createFixtureTask({
      id: createdTask.id,
      revision: 7,
      title: '先に取得した最新行',
    })
    const staleGetTask = createFixtureTask({
      id: createdTask.id,
      revision: 3,
      title: '古い一覧応答',
    })
    const harness = createControllerHarness(createdTask, [cachedTask], [staleGetTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.firstUpdaterResult).toEqual([cachedTask])
    expect(harness.currentTasks).toEqual([cachedTask])
    expect(harness.postCount).toBe(1)
  })

  test('refreshes the list when the create notification throws', async () => {
    const createdTask = createFixtureTask({
      id: 'notification-failed',
      revision: 1,
      title: '通知失敗後も一覧へ反映',
    })
    const harness = createControllerHarness(
      createdTask,
      [],
      [createdTask],
      [createdTask],
      () => {
        throw new Error('notification failed')
      },
    )

    const result = await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(result.task).toEqual(createdTask)
    expect(result.refreshError).toEqual(new Error('notification failed'))
    expect(harness.currentTasks).toEqual([createdTask])
    expect(harness.postCount).toBe(1)
  })

  test('preserves a newer cached revision when a stale GET omits the row', async () => {
    const createdTask = createFixtureTask({
      id: 'retry-missing',
      revision: 1,
      title: '古い POST 結果',
    })
    const cachedTask = createFixtureTask({
      id: createdTask.id,
      revision: 7,
      title: '先に取得した最新行',
    })
    const otherTask = createFixtureTask({ id: 'other-task', revision: 4 })
    const harness = createControllerHarness(createdTask, [cachedTask, otherTask], [otherTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.currentTasks).toEqual([cachedTask, otherTask])
    expect(harness.postCount).toBe(1)
  })

  test('allows a newer GET revision to replace the retained snapshot', async () => {
    const createdTask = createFixtureTask({ id: 'retry-get-newer', revision: 1 })
    const cachedTask = createFixtureTask({
      id: createdTask.id,
      revision: 7,
      title: '先に取得した行',
    })
    const newerGetTask = createFixtureTask({
      id: createdTask.id,
      revision: 9,
      title: 'GETで取得した最新行',
    })
    const harness = createControllerHarness(createdTask, [cachedTask], [newerGetTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.currentTasks).toEqual([newerGetTask])
    expect(harness.postCount).toBe(1)
  })

  test('preserves a newer concurrent cache row beyond the retained snapshot', async () => {
    const createdTask = createFixtureTask({ id: 'retry-concurrent', revision: 1 })
    const cachedTask = createFixtureTask({
      id: createdTask.id,
      revision: 7,
      title: '保持したスナップショット',
    })
    const returnedGetTask = createFixtureTask({
      id: createdTask.id,
      revision: 9,
      title: '再取得で確認した行',
    })
    const concurrentTask = createFixtureTask({
      id: createdTask.id,
      revision: 10,
      title: '並行更新で取得した最新行',
    })
    const harness = createControllerHarness(
      createdTask,
      [cachedTask],
      [returnedGetTask],
      [concurrentTask],
    )

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.currentTasks).toEqual([concurrentTask])
    expect(harness.postCount).toBe(1)
  })

  test('inserts a confirmed task when no matching cached row exists', async () => {
    const createdTask = createFixtureTask({ id: 'new-task', revision: 1 })
    const otherTask = createFixtureTask({ id: 'other-task', revision: 4 })
    const harness = createControllerHarness(createdTask, [otherTask], [createdTask, otherTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.firstUpdaterResult).toEqual([createdTask, otherTask])
    expect(harness.currentTasks).toEqual([createdTask, otherTask])
    expect(harness.postCount).toBe(1)
  })

  test('updates an older cached row with a newer confirmed POST result', async () => {
    const cachedTask = createFixtureTask({
      id: 'newer-post',
      revision: 3,
      title: '古いキャッシュ行',
    })
    const createdTask = createFixtureTask({
      id: cachedTask.id,
      revision: 7,
      title: '新しい POST 結果',
    })
    const harness = createControllerHarness(createdTask, [cachedTask], [createdTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.firstUpdaterResult).toEqual([createdTask])
    expect(harness.currentTasks).toEqual([createdTask])
    expect(harness.postCount).toBe(1)
  })

  test('re-inserts a task after an old GET omits it without dropping other rows', async () => {
    const createdTask = createFixtureTask({ id: 'eventually-visible', revision: 1 })
    const otherTask = createFixtureTask({ id: 'other-task', revision: 4 })
    const harness = createControllerHarness(createdTask, [otherTask], [otherTask])

    await harness.controller.createTask(createInput, {
      projectId: 'refero',
      teamId: 'core-team',
    })

    expect(harness.currentTasks).toEqual([createdTask, otherTask])
    expect(harness.postCount).toBe(1)
  })
})
