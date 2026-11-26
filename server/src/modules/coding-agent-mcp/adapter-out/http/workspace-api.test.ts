import { expect, test } from 'bun:test'
import { createWorkspaceApi } from './workspace-api'

const config = { origin: 'https://mukuroji.example.test', token: 'secret-test-token' }
const validTask = { id: 'task', teamId: 'team', revision: 1, title: 'Task', assigneeUserId: 'agent',
  workflowStatusId: 'todo', statusCategory: 'unstarted', priority: 'medium', dueDate: '',
  schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', relationIds: [], customFieldValues: {} }

test('sends the named Team with each request instead of a fixed one, and encodes IDs', async () => {
  const seen: URL[] = []
  const api = createWorkspaceApi(config, async (url) => {
    seen.push(url)
    return Response.json({ ...validTask, id: 'task/with?query', teamId: 'other' })
  })

  await api.getIssue('other', 'task/with?query')

  expect(seen[0]?.href).toBe('https://mukuroji.example.test/api/v1/work-items/task%2Fwith%3Fquery?teamId=other')
})

test('rejects Work Items, members, and keys of another scope than the one asked for', async () => {
  const otherTeam = createWorkspaceApi(config, async () => Response.json(validTask))
  await expect(otherTeam.getIssue('other', 'task')).rejects.toMatchObject({ code: 'invalid_response' })

  const otherProject = createWorkspaceApi(config, async () => Response.json({
    schemaVersion: 1, teamId: 'team', projectId: 'other', items: [],
  }))
  await expect(otherProject.projectMembers('team', 'project')).rejects.toMatchObject({ code: 'invalid_response' })

  const otherKey = createWorkspaceApi(config, async () => Response.json({
    schemaVersion: 1, key: 'ABC-2', teamId: 'team', workItemId: 'task',
  }))
  await expect(otherKey.lookupKey('ABC-1')).rejects.toMatchObject({ code: 'invalid_response' })

  const otherCharter = createWorkspaceApi(config, async () => Response.json({
    schemaVersion: 1, teamId: 'other', projectId: 'project', lifecycleState: 'active', revision: 1, tags: [], repositoryUrls: [],
  }))
  await expect(otherCharter.projectCharter('team', 'project')).rejects.toMatchObject({ code: 'invalid_response' })
})

test('reads a Project charter of the named Team and lists Work Items by title words', async () => {
  const seen: string[] = []
  const api = createWorkspaceApi(config, async (url) => {
    seen.push(`${url.pathname}${url.search}`)
    return url.pathname.endsWith('/charter')
      ? Response.json({ schemaVersion: 1, teamId: 'team', projectId: 'project', lifecycleState: 'active', revision: 1, tags: [], repositoryUrls: [] })
      : Response.json({ items: [], hasMore: false })
  })

  expect(await api.projectCharter('team', 'project')).toMatchObject({ projectId: 'project', revision: 1 })
  await api.listIssues('team', { query: 'ログイン 失敗' })

  expect(seen).toEqual([
    '/api/v1/projects/project/charter?teamId=team',
    `/api/v1/work-items?teamId=team&query=${encodeURIComponent('ログイン 失敗').replaceAll('%20', '+')}&limit=50`,
  ])
})

test('reports a missing key endpoint as no key and keeps other failures', async () => {
  const missing = createWorkspaceApi(config, async () => Response.json({}, { status: 404 }))
  expect(await missing.getKey('team', 'task')).toBeUndefined()

  const denied = createWorkspaceApi(config, async () => Response.json({}, { status: 403 }))
  await expect(denied.getKey('team', 'task')).rejects.toMatchObject({ code: 'forbidden' })
})

test('refuses an insecure origin and never echoes the token in errors', async () => {
  expect(() => createWorkspaceApi({ ...config, origin: 'http://example.test' })).toThrow()
  const broken = createWorkspaceApi(config, async () => new Response('secret-test-token raw upstream error', { status: 500 }))
  try {
    await broken.me()
  } catch (error) {
    expect(String(error)).not.toContain('secret-test-token')
  }
  await expect(broken.me()).rejects.toMatchObject({ code: 'unavailable', retryable: true })
})

test('sends writes with the idempotency key and rejects a Work Item saved in another Team', async () => {
  const seen: { url: string, method: string | undefined, key: string | null }[] = []
  const api = createWorkspaceApi(config, async (url, init) => {
    seen.push({ url: url.href, method: init.method, key: new Headers(init.headers).get('Idempotency-Key') })
    return Response.json(validTask)
  })
  const key = '00000000-0000-4000-8000-000000000001'

  await api.updateIssue('team', 'task', { expectedRevision: 1, title: 'Renamed' }, key)
  expect(seen[0]).toEqual({ url: 'https://mukuroji.example.test/api/v1/work-items/task?teamId=team', method: 'PATCH', key })

  await expect(api.createIssue({ teamId: 'other', title: 'Task', assigneeUserId: 'agent', priority: 'medium' }, key))
    .rejects.toMatchObject({ code: 'invalid_response' })
  await expect(api.updateIssue('team', 'another-task', { expectedRevision: 1, title: 'Renamed' }, key))
    .rejects.toMatchObject({ code: 'invalid_response' })
})

test('sends relation writes to the named Work Item and rejects relations of another Work Item', async () => {
  const seen: { url: string, method: string | undefined, key: string | null, body: unknown }[] = []
  const api = createWorkspaceApi(config, async (url, init) => {
    seen.push({
      url: url.href, method: init.method, key: new Headers(init.headers).get('Idempotency-Key'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', relation: { type: 'blocks', targetWorkItemId: 'other' } })
  })

  await api.createRelation('team', 'task', { type: 'blocks', targetWorkItemId: 'other' }, 'link-key')
  await api.deleteRelation('team', 'task', 'other', 'blocks', 'unlink-key')
  await expect(api.createRelation('team', 'another-task', { type: 'blocks', targetWorkItemId: 'other' }, 'link-key'))
    .rejects.toMatchObject({ code: 'invalid_response' })

  expect(seen.slice(0, 2)).toEqual([
    { url: 'https://mukuroji.example.test/api/v1/work-items/task/relations?teamId=team', method: 'POST', key: 'link-key', body: { type: 'blocks', targetWorkItemId: 'other' } },
    { url: 'https://mukuroji.example.test/api/v1/work-items/task/relations/other/blocks?teamId=team', method: 'DELETE', key: 'unlink-key', body: undefined },
  ])
})

test('reserves a subtask batch for the named parent and rejects a batch of another Work Item', async () => {
  const seen: { url: string, method: string | undefined, key: string | null, body: unknown }[] = []
  const api = createWorkspaceApi(config, async (url, init) => {
    seen.push({
      url: url.href, method: init.method, key: new Headers(init.headers).get('Idempotency-Key'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'parent', subtaskCount: 1 })
  })
  const input = { subtasks: [{ title: 'Design', assigneeUserId: 'owner', priority: 'medium' }] }

  expect(await api.reserveSubtaskBatch('team', 'parent', input, 'batch-key'))
    .toEqual({ schemaVersion: 1, teamId: 'team', workItemId: 'parent', subtaskCount: 1 })
  await expect(api.reserveSubtaskBatch('team', 'another-parent', input, 'batch-key')).rejects.toMatchObject({ code: 'invalid_response' })
  expect(seen[0]).toEqual({
    url: 'https://mukuroji.example.test/api/v1/work-items/parent/subtask-batches?teamId=team', method: 'POST', key: 'batch-key', body: input,
  })
})

test('sends web link reads and writes to the named Work Item and rejects links of another Work Item', async () => {
  const link = { id: 'b'.repeat(32), url: 'https://example.com/a', createdByMemberId: 'owner', createdAt: '2026-11-26T00:00:00.000Z' }
  const seen: { url: string, method: string | undefined, key: string | null, body: unknown }[] = []
  const api = createWorkspaceApi(config, async (url, init) => {
    seen.push({
      url: url.href, method: init.method, key: new Headers(init.headers).get('Idempotency-Key'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return init.method === 'GET' || init.method === undefined
      ? Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', items: [link] })
      : Response.json({ schemaVersion: 1, teamId: 'team', workItemId: 'task', link })
  })

  expect((await api.webLinks('team', 'task')).items).toEqual([link])
  await api.createWebLink('team', 'task', { url: 'https://example.com/a', title: 'A' }, 'add-key')
  await api.deleteWebLink('team', 'task', link.id, 'remove-key')
  await expect(api.createWebLink('team', 'another-task', { url: 'https://example.com/a' }, 'add-key'))
    .rejects.toMatchObject({ code: 'invalid_response' })
  await expect(api.deleteWebLink('team', 'task', '../x', 'remove-key')).rejects.toMatchObject({ code: 'invalid_request' })

  expect(seen.slice(0, 3)).toEqual([
    { url: 'https://mukuroji.example.test/api/v1/work-items/task/web-links?teamId=team', method: 'GET', key: null, body: undefined },
    { url: 'https://mukuroji.example.test/api/v1/work-items/task/web-links?teamId=team', method: 'POST', key: 'add-key', body: { url: 'https://example.com/a', title: 'A' } },
    { url: `https://mukuroji.example.test/api/v1/work-items/task/web-links/${link.id}?teamId=team`, method: 'DELETE', key: 'remove-key', body: undefined },
  ])
})

test('rejects a web link list whose link is not an http URL', async () => {
  const api = createWorkspaceApi(config, async () => Response.json({
    schemaVersion: 1, teamId: 'team', workItemId: 'task',
    items: [{ id: 'c'.repeat(32), url: 'javascript:alert(1)', createdByMemberId: 'owner', createdAt: '2026-11-26T00:00:00.000Z' }],
  }))
  await expect(api.webLinks('team', 'task')).rejects.toMatchObject({ code: 'invalid_response' })
})
