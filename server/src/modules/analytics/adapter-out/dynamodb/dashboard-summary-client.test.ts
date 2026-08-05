import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  resetTestApp,
} = createApiTestHarness()
import {
  DynamoDbDashboardSummaryClient,
} from './dashboard-summary-client'
import type { ProjectRole } from '../../../directory'
import {
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('DynamoDB dashboard summary client derives counts from canonical Work Items', async () => {
  const accessListReads: Array<{ directoryId: string; memberKey: string }> = []
  const projectIssueReads: Array<{ directoryId: string; projectId: string }> = []
  const client = new DynamoDbDashboardSummaryClient(
    {
      async getProjectDirectory() {
        return {
          teams: [{
            id: 'core-team',
            name: 'Core Team',
            expanded: true,
            projects: [
              { id: 'refero', name: 'Refero', tone: 'blue' as const },
              { id: 'private', name: 'Private', tone: 'purple' as const },
            ],
          }],
        }
      },
      async getProjectAccessList(directoryId: string, memberKey: string) {
        accessListReads.push({ directoryId, memberKey })
        return [{ projectId: 'refero', role: 'viewer' as ProjectRole }]
      },
    } as never,
    {
      async getProjectIssues(directoryId: string, projectId: string) {
        projectIssueReads.push({ directoryId, projectId })
        return {
          projectId,
          issues: [
            {
              schemaVersion: 2 as const,
              revision: 1,
              id: 'active-high',
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: 'Active high priority Work Item',
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'in-progress',
              statusCategory: 'started' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026-07-20',
              schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
              priority: 'high' as const,
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
              source: 'dynamodb' as const,
            },
            {
              schemaVersion: 2 as const,
              revision: 1,
              id: 'completed-high',
              teamId: 'core-team',
              assignedProjectId: projectId,
              title: 'Completed high priority Work Item',
              assigneeUserId: 'sato@example.com',
              creatorMemberKey: 'demo@example.com',
              workflowSchemaVersion: 1 as const,
              workflowStatusId: 'done',
              statusCategory: 'completed' as const,
              customFieldValues: {},
              relationIds: [],
              dueDate: '2026-07-20',
              schedule: createDefaultDueDateWorkItemSchedule('2026-07-20'),
              priority: 'high' as const,
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
              source: 'dynamodb' as const,
            },
          ],
        }
      },
    } as never,
  )

  const summary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
  })

  expect(summary).toMatchObject({
    projects: 1,
    tasks: 1,
    blocked: 1,
    source: 'dynamodb',
  })
  expect(Date.parse(summary.updatedAt)).not.toBeNaN()
  expect(accessListReads).toEqual([{
    directoryId: 'user#demo@example.com',
    memberKey: 'demo@example.com',
  }])
  expect(projectIssueReads).toEqual([{
    directoryId: 'user#demo@example.com',
    projectId: 'refero',
  }])

  const enterpriseSummary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
    projectAccesses: [{ projectId: 'private', role: 'viewer' }],
  })
  const removedMappingSummary = await client.getSummary('user#demo@example.com', {
    userKey: 'demo@example.com',
    isSystemAdmin: false,
    projectAccesses: [],
  })

  expect(enterpriseSummary.projects).toBe(1)
  expect(removedMappingSummary).toMatchObject({ projects: 0, tasks: 0, blocked: 0 })
  expect(accessListReads).toHaveLength(1)
  expect(projectIssueReads.at(-1)).toEqual({
    directoryId: 'user#demo@example.com',
    projectId: 'private',
  })
})
