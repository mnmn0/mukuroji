import { afterEach, describe, expect, test } from 'bun:test'
import {
  createWorkloadAssignment,
  createWorkloadRequest,
  previewWorkloadAssignment,
  saveWorkloadProfile,
  saveWorkloadTimeOff,
  updateWorkloadAssignment,
} from '../src/workload/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('workload API', () => {
  test('uses the capacity-planning mutation routes and concurrency fields', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = []
    installFetchRecorder(requests)
    const schedule = {
      monday: { enabled: true, minutes: 480 },
      tuesday: { enabled: true, minutes: 480 },
      wednesday: { enabled: true, minutes: 480 },
      thursday: { enabled: true, minutes: 480 },
      friday: { enabled: true, minutes: 480 },
      saturday: { enabled: false, minutes: 0 },
      sunday: { enabled: false, minutes: 0 },
    }

    await saveWorkloadProfile('token', 'team/1', 'member/1', {
      displayName: 'Hanako',
      skills: ['typescript'],
      timeZone: 'Asia/Tokyo',
      schedule,
      holidays: [],
      expectedRevision: 0,
      expectedTeamRevision: 4,
    })
    await saveWorkloadTimeOff('token', 'team/1', 'member/1', 'time-off/1', {
      fromDate: '2026-08-10',
      toDate: '2026-08-10',
      status: 'approved',
      expectedRevision: 1,
      expectedTeamRevision: 5,
    })
    await createWorkloadRequest('token', 'team/1', {
      title: 'Release support',
      skillIds: ['typescript'],
      fromDate: '2026-08-10',
      toDate: '2026-08-14',
      requestedMinutes: 480,
      confidential: false,
      expectedTeamRevision: 6,
    })
    await createWorkloadAssignment('token', 'team/1', {
      memberId: 'member/1',
      skillIds: [],
      fromDate: '2026-08-10',
      toDate: '2026-08-14',
      allocationMinutes: 480,
      plannedEffortMinutes: 480,
      confidential: false,
      status: 'tentative',
      expectedTeamRevision: 7,
    })
    await updateWorkloadAssignment('token', 'team/1', 'assignment/1', {
      memberId: 'member/2',
      fromDate: '2026-08-11',
      toDate: '2026-08-11',
      expectedRevision: 1,
      expectedTeamRevision: 8,
    })

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ['PUT', '/api/teams/team%2F1/workload/profiles/member%2F1'],
      ['PUT', '/api/teams/team%2F1/workload/profiles/member%2F1/time-off/time-off%2F1'],
      ['POST', '/api/teams/team%2F1/workload/requests'],
      ['POST', '/api/teams/team%2F1/workload/assignments'],
      ['PATCH', '/api/teams/team%2F1/workload/assignments/assignment%2F1'],
    ])
    expect(JSON.parse(requests[4]?.body ?? '{}')).toMatchObject({
      expectedRevision: 1,
      expectedTeamRevision: 8,
    })
  })

  test('returns a validated what-if snapshot', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = []
    installFetchRecorder(requests, {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      fromDate: '2026-08-10',
      toDate: '2026-08-10',
      granularity: 'day',
      members: [],
      requests: [],
      assignments: [],
      redactedAssignmentCount: 0,
      redactedRequestCount: 0,
      revision: 1,
      generatedAt: '2026-08-02T00:00:00.000Z',
    })

    await expect(previewWorkloadAssignment('token', 'team-1', {
      fromDate: '2026-08-10',
      toDate: '2026-08-10',
      granularity: 'day',
      memberId: 'member-1',
      assignmentFromDate: '2026-08-10',
      assignmentToDate: '2026-08-10',
      allocationMinutes: 480,
      plannedEffortMinutes: 480,
    })).resolves.toMatchObject({ schemaVersion: 1 })
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/teams/team-1/workload/what-if',
    })
  })
})

/** Installs a deterministic fetch stub and records outgoing workload requests. */
function installFetchRecorder(
  requests: Array<{ method: string; url: string; body: string }>,
  responseBody: Record<string, unknown> = {},
): void {
  globalThis.fetch = async (input, init) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return new Response(JSON.stringify(responseBody), { status: 200 })
  }
}
