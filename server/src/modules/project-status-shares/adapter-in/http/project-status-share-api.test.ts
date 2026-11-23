import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeProjectClients,
  getTestAppDependencies,
  resetTestApp,
} = createApiTestHarness()
import type {
  CreateProjectStatusShareResponse,
  ProjectStatusReport,
  ProjectStatusShareListResponse,
  PublicProjectStatusReportResponse,
} from '@mukuroji/contracts'
import { afterEach, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { InMemoryProjectStatusShareStore } from '../../adapter-out/dynamodb/project-status-share-store'
import { readPublicProjectStatusReportUseCase } from '../../application/project-status-share-use-cases'

afterEach(() => {
  resetTestApp()
})

/** Report covering every section, with names in the update and the action items. */
const report: ProjectStatusReport = {
  schemaVersion: 1,
  locale: 'ja',
  projectName: '基幹刷新',
  teamName: 'コアチーム',
  asOf: '2026-11-23T03:00:00.000Z',
  health: {
    health: 'at-risk',
    risk: 'medium',
    summary: '結合試験が1週間遅れています。',
    publishedAt: '2026-11-22T09:00:00.000Z',
    authorName: '山田 花子',
  },
  schedule: {
    items: [{
      type: 'milestone',
      title: '結合試験完了',
      status: 'active',
      health: 'at-risk',
      progress: 60,
      forecastEndDate: '2026-12-08',
      baselineEndDate: '2026-12-01',
      delayDays: 7,
    }],
    hiddenCount: 0,
    delayedCount: 1,
  },
  progress: {
    totalCount: 10,
    openCount: 6,
    inProgressCount: 3,
    doneCount: 4,
    completionRate: 40,
    overdueCount: 1,
    blockedCount: 0,
  },
  risks: {
    openRiskCount: 1,
    openIssueCount: 0,
    pendingDecisionCount: 0,
    items: [{ kind: 'risk', title: 'ベンダー納期', severity: 'high', response: '代替先を確保' }],
    hiddenCount: 0,
  },
  nextActions: {
    items: [{ text: '試験環境を増強する', dueDate: '2026-11-30', ownerName: '佐藤 一郎', overdue: false }],
    hiddenCount: 0,
  },
}

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @param headers - Extra headers.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: {
      ...headers,
      Authorization: 'Bearer test-token',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Finds a Project of the fake Team that the demo user may use.
 *
 * @returns The Project ID of the first fake Team Work Item.
 */
async function readProjectId(): Promise<string> {
  const { issues } = await getTestAppDependencies().workItems.teamIssues.getTeamIssues(
    'user#demo@example.com',
    'core-team',
  )
  const projectId = issues[0]?.assignedProjectId
  if (!projectId) throw new Error('The fake Team has no Project Work Item.')
  return projectId
}

test('creates a redacted share, serves it publicly, counts the view, and stops after revocation', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/status-shares`

  const created = await request(path, 'POST', {
    report,
    label: ' 顧客A向け ',
    sections: ['progress', 'health', 'nextActions'],
    showPeopleNames: false,
    expiresInDays: 14,
  })
  expect(created.status).toBe(201)
  const { share, url } = await created.json() as CreateProjectStatusShareResponse
  expect(share).toMatchObject({
    label: '顧客A向け',
    sections: ['health', 'progress', 'nextActions'],
    showPeopleNames: false,
    viewCount: 0,
    reportAsOf: report.asOf,
  })
  expect(url).toMatch(/^\/share\/project-status\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u)
  const token = decodeURIComponent(url.slice('/share/project-status/'.length))

  const viewed = await app.request(`/api/public/project-status/${encodeURIComponent(token)}`)
  expect(viewed.status).toBe(200)
  expect(viewed.headers.get('Cache-Control')).toBe('private, no-store')
  const published = await viewed.json() as PublicProjectStatusReportResponse
  expect(published.report.schedule).toBeUndefined()
  expect(published.report.risks).toBeUndefined()
  expect(published.report.health?.authorName).toBeUndefined()
  expect(published.report.nextActions?.items[0]?.ownerName).toBeUndefined()
  expect(published.report.progress?.completionRate).toBe(40)
  expect(JSON.stringify(published)).not.toContain('山田')

  const pdf = await app.request(`/api/public/project-status/${encodeURIComponent(token)}/pdf`)
  expect(pdf.status).toBe(200)
  expect(pdf.headers.get('Content-Type')).toBe('application/pdf')
  expect(new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 8))).toBe('%PDF-1.4')

  // A second view within a minute is not counted again.
  await app.request(`/api/public/project-status/${encodeURIComponent(token)}`)
  const listed = await request(path)
  expect(listed.status).toBe(200)
  const shares = (await listed.json() as ProjectStatusShareListResponse).shares
  expect(shares).toHaveLength(1)
  expect(shares[0]).toMatchObject({ id: share.id, viewCount: 1 })

  const store = getTestAppDependencies().workItems.projectStatusShares
  if (!(store instanceof InMemoryProjectStatusShareStore)) throw new Error('Expected the in-memory store.')
  expect(store.auditEvents.map((event) => event.action)).toEqual(['status_share_created', 'status_share_viewed'])

  const revoked = await request(`${path}/${share.id}/revoke`, 'POST', {})
  expect(revoked.status).toBe(200)
  expect((await revoked.json() as { share: { revokedAt?: string } }).share.revokedAt).toBeString()
  const gone = await app.request(`/api/public/project-status/${encodeURIComponent(token)}`)
  expect(gone.status).toBe(404)
  expect(store.auditEvents.map((event) => event.action)).toContain('status_share_revoked')
})

test('returns the same link when a creation is retried with its idempotency key', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/status-shares`
  const body = { report, label: '顧客A', sections: ['health'], showPeopleNames: false, expiresInDays: 7 }
  const headers = { 'Idempotency-Key': 'share-retry-1' }

  const first = await request(path, 'POST', body, headers)
  expect(first.status).toBe(201)
  const retried = await request(path, 'POST', body, headers)
  expect(retried.status).toBe(201)
  const firstBody = await first.json() as CreateProjectStatusShareResponse
  expect(await retried.json()).toEqual(firstBody)

  const changed = await request(path, 'POST', { ...body, label: '顧客B' }, headers)
  expect(changed.status).toBe(409)
  const other = await request(path, 'POST', body, { 'Idempotency-Key': 'share-retry-2' })
  expect(other.status).toBe(201)
  expect((await other.json() as CreateProjectStatusShareResponse).url).not.toBe(firstBody.url)

  const shares = (await (await request(path)).json() as ProjectStatusShareListResponse).shares
  expect(shares).toHaveLength(2)
})

test('rejects a creation that checked the limits against a stale revision', async () => {
  const store = new InMemoryProjectStatusShareStore()
  const scope = { workspaceId: 'ws-1', teamId: 'team-1', projectId: 'project-1' }
  const { createProjectStatusShareUseCase } = await import('../../application/project-status-share-use-cases')
  const create = (requestSecret: string, target = store) => createProjectStatusShareUseCase(target, scope, {
    report,
    label: 'A',
    sections: ['health'],
    showPeopleNames: false,
    expiresInDays: 7,
  }, {
    now: '2026-11-23T00:00:00.000Z',
    callerAuthorization: [{ ConditionCheck: undefined }],
    auditContext: undefined,
    createdByMemberKey: 'member-1',
    requestSecret,
    checks: { verifyCustomerContact: async () => undefined },
  })
  await create('request-secret-one-0000000000000000000')
  // A concurrent request read the revision before the first share was stored.
  const stale: InMemoryProjectStatusShareStore = Object.assign(Object.create(store), {
    readRevision: async () => 0,
  })
  await expect(create('request-secret-two-0000000000000000000', stale)).rejects.toMatchObject({ status: 409 })
  expect(await store.list(scope)).toHaveLength(1)
})

test('answers the same 404 for malformed and unknown tokens', async () => {
  configureFakeProjectClients(true)
  for (const token of ['x', 'abc.def', `${Buffer.from('user#demo@example.com').toString('base64url')}.${'A'.repeat(43)}`]) {
    const response = await app.request(`/api/public/project-status/${encodeURIComponent(token)}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'ProjectStatusShareNotFound' })
  }
})

/** Directory of the predefined CMaps pdf.js needs to read the fallback Japanese font. */
const pdfCMapDirectory = `${dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))}/cmaps/`

/**
 * Extracts the text of every page of a PDF with pdf.js.
 *
 * @param bytes - PDF bytes.
 * @returns Page texts joined without separators.
 */
async function readPdfText(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes, cMapUrl: pdfCMapDirectory, cMapPacked: true })
  const document = await loadingTask.promise
  const pages = await Promise.all(
    Array.from({ length: document.numPages }, async (_, index) => {
      const page = await document.getPage(index + 1)
      const content = await page.getTextContent()
      return content.items.flatMap((item) => 'str' in item ? [item.str] : []).join('')
    }),
  )
  await loadingTask.destroy()
  return pages.join('')
}

test('renders an authenticated PDF export of a report with its Japanese text', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const response = await request(`/api/teams/core-team/projects/${projectId}/status-report/pdf`, 'POST', { report })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/pdf')
  const text = await readPdfText(new Uint8Array(await response.arrayBuffer()))
  expect(text).toContain('基幹刷新 進捗レポート')
  expect(text).toContain('結合試験完了')
  expect(text).toContain('完了率 40%')
  expect(text).toContain('担当: 佐藤 一郎')
  const invalid = await request(`/api/teams/core-team/projects/${projectId}/status-report/pdf`, 'POST', {
    report: { ...report, schemaVersion: 2 },
  })
  expect(invalid.status).toBe(400)
})

test('rejects invalid share input', async () => {
  configureFakeProjectClients(true)
  const projectId = await readProjectId()
  const path = `/api/teams/core-team/projects/${projectId}/status-shares`
  const base = { report, label: 'A', sections: ['health'], showPeopleNames: true, expiresInDays: 7 }
  for (const body of [
    { ...base, sections: [] },
    { ...base, sections: ['budget'] },
    { ...base, expiresInDays: 91 },
    { ...base, label: '' },
    { ...base, contactId: 'contact-1' },
    { ...base, report: { ...report, progress: { ...report.progress, completionRate: 101 } } },
  ]) {
    const response = await request(path, 'POST', body)
    expect(response.status).toBe(400)
  }
})

test('lets a Project viewer export but not manage share links', async () => {
  configureFakeProjectClients(true, { projectAccesses: [{ projectId: 'refero', role: 'viewer' }] })
  const pdf = await request('/api/teams/core-team/projects/refero/status-report/pdf', 'POST', { report })
  expect(pdf.status).toBe(200)
  const listed = await request('/api/teams/core-team/projects/refero/status-shares')
  expect(listed.status).toBe(403)
  const created = await request('/api/teams/core-team/projects/refero/status-shares', 'POST', {
    report,
    label: 'A',
    sections: ['health'],
    showPeopleNames: true,
    expiresInDays: 7,
  })
  expect(created.status).toBe(403)
  expect(await created.json()).toMatchObject({ code: 'ProjectStatusShareForbidden' })
})

test('answers 404 for a Project outside the Team and 401 without a token', async () => {
  configureFakeProjectClients(true)
  expect((await request('/api/teams/core-team/projects/not-in-team/status-shares')).status).toBe(404)
  expect((await app.request('/api/teams/core-team/projects/p/status-shares')).status).toBe(401)
})

test('hides an expired link, a closed Workspace, and an archived Project', async () => {
  const store = new InMemoryProjectStatusShareStore()
  const scope = { workspaceId: 'ws-1', teamId: 'team-1', projectId: 'project-1' }
  const { createProjectStatusShareUseCase } = await import('../../application/project-status-share-use-cases')
  const { url } = await createProjectStatusShareUseCase(store, scope, {
    report,
    label: 'A',
    sections: ['health'],
    showPeopleNames: true,
    expiresInDays: 1,
  }, {
    now: '2026-11-23T00:00:00.000Z',
    callerAuthorization: [{ ConditionCheck: undefined }],
    auditContext: undefined,
    createdByMemberKey: 'member-1',
    requestSecret: 'request-secret-for-the-expiry-test-0000',
    checks: { verifyCustomerContact: async () => undefined },
  })
  const token = decodeURIComponent(url.slice('/share/project-status/'.length))
  const active = { assertWorkspaceActive: async () => undefined, isProjectActive: async () => true }
  const open = await readPublicProjectStatusReportUseCase(store, token, new Date('2026-11-23T12:00:00.000Z'), active)
  expect(open.response.report.health?.authorName).toBe('山田 花子')
  await expect(readPublicProjectStatusReportUseCase(store, token, new Date('2026-11-24T00:00:00.000Z'), active))
    .rejects.toMatchObject({ status: 404 })
  await expect(readPublicProjectStatusReportUseCase(store, token, new Date('2026-11-23T12:00:00.000Z'), {
    ...active,
    assertWorkspaceActive: async () => { throw new Error('closed') },
  })).rejects.toMatchObject({ status: 404 })
  await expect(readPublicProjectStatusReportUseCase(store, token, new Date('2026-11-23T12:00:00.000Z'), {
    ...active,
    isProjectActive: async () => false,
  })).rejects.toMatchObject({ status: 404 })
})
