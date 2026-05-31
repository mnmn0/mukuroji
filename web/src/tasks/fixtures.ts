import type { ProjectTask } from './api'

/**
 * TaskPage の Storybook と E2E で共有する Refero タスク fixture です。
 */
export const referoTaskFixtures = [
  {
    id: 'wireframe',
    titleKey: 'tasks.item.wireframe',
    assigneeKey: 'tasks.assignee.sato',
    status: 'in-progress',
    dueDate: '2025/05/26',
    priority: 'high',
  },
  {
    id: 'brand-guideline',
    titleKey: 'tasks.item.brandGuideline',
    assigneeKey: 'tasks.assignee.suzuki',
    status: 'review',
    dueDate: '2025/05/27',
    priority: 'medium',
  },
  {
    id: 'seo-research',
    titleKey: 'tasks.item.seoResearch',
    assigneeKey: 'tasks.assignee.yamamoto',
    status: 'todo',
    dueDate: '2025/05/29',
    priority: 'medium',
  },
  {
    id: 'competitor-report',
    titleKey: 'tasks.item.competitorReport',
    assigneeKey: 'tasks.assignee.tanaka',
    status: 'done',
    dueDate: '2025/06/03',
    priority: 'low',
  },
] satisfies ProjectTask[]
