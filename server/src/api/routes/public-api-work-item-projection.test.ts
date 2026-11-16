import { expect, test } from 'bun:test'
import {
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { projectPublicWorkItem } from './public-api-routes'

const workItem = {
  schemaVersion: WORK_ITEM_SCHEMA_VERSION,
  revision: 3,
  id: 'api-key-ui',
  teamId: 'core',
  title: 'API key UI',
  assigneeUserId: 'owner@example.com',
  creatorMemberKey: 'owner@example.com',
  workflowStatusId: 'done',
  statusCategory: 'completed',
  workflowSchemaVersion: 1,
  customFieldValues: {},
  relationIds: [],
  dueDate: '2026-08-01',
  schedule: createDefaultDueDateWorkItemSchedule('2026-08-01'),
  priority: 'high',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  source: 'dynamodb',
} satisfies CanonicalWorkItem

test('public Work Items carry recorded actual dates and omit missing ones', () => {
  expect(projectPublicWorkItem({ ...workItem, actualStartDate: '2026-07-20', actualEndDate: '2026-08-03' }))
    .toMatchObject({ actualStartDate: '2026-07-20', actualEndDate: '2026-08-03' })
  const legacy = projectPublicWorkItem(workItem)
  expect(legacy).not.toHaveProperty('actualStartDate')
  expect(legacy).not.toHaveProperty('actualEndDate')
})
