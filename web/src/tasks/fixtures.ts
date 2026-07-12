import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import type { ProjectTask } from './api'

/**
 * TaskPage の Storybook と E2E で共有する Refero タスク fixture です。
 */
export const referoTaskFixtures = [
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'wireframe',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'in-progress',
    dueDate: '2026/06/03',
    priority: 'high',
    source: 'legacy',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'brand-guideline',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.brandGuideline',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'review',
    dueDate: '2026/06/05',
    priority: 'medium',
    source: 'legacy',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'seo-research',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.seoResearch',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2026/06/09',
    priority: 'medium',
    source: 'legacy',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'competitor-report',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    titleKey: 'tasks.item.competitorReport',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'done',
    dueDate: '2026/06/02',
    priority: 'low',
    source: 'legacy',
  },
] satisfies ProjectTask[]
