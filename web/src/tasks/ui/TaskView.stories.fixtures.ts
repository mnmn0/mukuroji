import {
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type ResolvedWorkItemConfiguration,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import type { TeamIssueDetail } from '../../issues/api'
import type { CanonicalWorkItem } from '../api/tasks'
import type { ProjectMember, ProjectUser } from '../../projects/api'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { fileArtifactsControllerFixture } from '../../files/fixtures'
import {
  teamWorkItemConfigurationFixture,
  workItemCustomFieldValueFixture,
} from '../../work-items/fixtures'
import type { ProjectTaskStatusColumn } from '../model/taskView'
import {
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultMilestoneTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
} from '../model/taskSchedule'

/** Task selected by the independent detail-pane story. */
export const taskViewStorySelectedTask = {
  schemaVersion: WORK_ITEM_SCHEMA_VERSION,
  revision: 1,
  id: 'wireframe',
  teamId: 'core-team',
  assignedProjectId: 'refero',
  title: 'ワイヤーフレームを確認する',
  assigneeUserId: 'sato@example.com',
  creatorMemberKey: 'sato@example.com',
  workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  workflowStatusId: 'active',
  statusCategory: 'started',
  customFieldValues: {},
  relationIds: [],
  dueDate: '2026-06-03',
  schedule: createDefaultDateRangeTaskSchedule('2026-06-01', '2026-06-03'),
  priority: 'high',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  source: 'dynamodb',
} satisfies CanonicalWorkItem

/** Project tasks shared by the independent task-view stories. */
export const taskViewStoryTasks = [
  taskViewStorySelectedTask,
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'brand-guideline',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: 'ブランドガイドラインを更新する',
    assigneeUserId: 'suzuki@example.com',
    creatorMemberKey: 'suzuki@example.com',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'review',
    statusCategory: 'started',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-05',
    schedule: createDefaultMilestoneTaskSchedule('2026-06-05'),
    priority: 'medium',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    source: 'dynamodb',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'seo-research',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: 'SEOリサーチをまとめる',
    assigneeUserId: 'sato@example.com',
    creatorMemberKey: 'sato@example.com',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'ready',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-06-09',
    schedule: createDefaultDueDateTaskSchedule('2026-06-09'),
    priority: 'medium',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    source: 'dynamodb',
  },
  {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'competitor-report',
    teamId: 'core-team',
    assignedProjectId: 'refero',
    title: '競合調査レポートを完成する',
    assigneeUserId: 'suzuki@example.com',
    creatorMemberKey: 'suzuki@example.com',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'done',
    statusCategory: 'completed',
    customFieldValues: {},
    relationIds: [],
    dueDate: '',
    schedule: createDefaultUnscheduledTaskSchedule(),
    priority: 'low',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    source: 'dynamodb',
  },
] satisfies CanonicalWorkItem[]

/** Planning graph aligned with task-view stories for dependency chips and Gantt lines. */
export const taskViewStoryPlanningSnapshot = {
  schemaVersion: PLANNING_SCHEMA_VERSION,
  revision: 4,
  entities: [],
  updateTargets: [],
  dependencies: [],
  workItemDependencies: [
    {
      id: 'story-wireframe-brand',
      predecessor: { teamId: 'core-team', workItemId: 'wireframe' },
      successor: { teamId: 'core-team', workItemId: 'brand-guideline' },
      type: 'start-to-finish',
      lagDays: -1,
      constraint: { anchor: 'finish', kind: 'not-after', date: '2026-06-05' },
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
  ],
  workItemLinks: [],
  workItems: taskViewStoryTasks.map((task) => ({
    dueDate: task.dueDate,
    id: task.id,
    projectId: task.assignedProjectId,
    revision: task.revision,
    schedule: task.schedule,
    statusCategory: task.statusCategory,
    teamId: task.teamId,
    title: task.title,
  })),
  criticalPath: { entityIds: [], slackByEntityId: {}, totalDurationDays: 0 },
  workItemDependencySummary: {
    affectedMilestoneIds: [],
    affectedProjects: [{ projectId: 'refero', teamId: 'core-team' }],
    conflicts: [],
    criticalPath: {
      slackByWorkItemKey: {
        'core-team/brand-guideline': 0,
        'core-team/wireframe': 0,
      },
      totalDurationDays: 5,
      workItems: [
        { teamId: 'core-team', workItemId: 'wireframe' },
        { teamId: 'core-team', workItemId: 'brand-guideline' },
      ],
    },
    unresolvedBlockerCount: 1,
  },
  updatedAt: '2026-06-01T00:00:00.000Z',
} satisfies PlanningSnapshot

/** Matching detail response used by the independent selected-task story. */
export const taskViewStorySelectedIssueDetail = {
  activity: [],
  comments: [],
  issue: {
    ...taskViewStorySelectedTask,
    assigneeEmail: 'sato@example.com',
    assigneeName: '佐藤 花子',
    customFieldValues: workItemCustomFieldValueFixture,
    description: 'Refero の初回作業面を確認し、次に進める判断材料をそろえます。',
  },
  relations: [],
  resolvedConfiguration: {
    configuration: teamWorkItemConfigurationFixture,
  },
} satisfies TeamIssueDetail

/** Single-team configuration map shared by task-view stories. */
export const taskViewStoryConfigurationsByTeam = {
  'core-team': {
    configuration: teamWorkItemConfigurationFixture,
  },
} satisfies Record<string, ResolvedWorkItemConfiguration>

/** Team-scoped workflow columns shared by the board story. */
export const taskViewStoryStatusColumns = teamWorkItemConfigurationFixture.workflow.statuses.map(
  (status) => ({
    key: `core-team:${status.id}`,
    label: status.name,
    status,
    teamId: 'core-team',
  }),
) satisfies ProjectTaskStatusColumn[]

/** Project members shared by table and permission-view stories. */
export const taskViewStoryProjectMembers = [
  {
    id: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    role: 'manager',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
  },
  {
    id: 'suzuki@example.com',
    email: 'suzuki@example.com',
    name: '鈴木 大輔',
    role: 'member',
    updatedAt: '2026-06-08T00:00:00.000Z',
    workspaceStatus: 'active',
  },
] satisfies ProjectMember[]

/** Project user candidates shared by the permission-view story. */
export const taskViewStoryProjectUsers = [
  {
    id: 'sato@example.com',
    username: 'sato@example.com',
    email: 'sato@example.com',
    name: '佐藤 花子',
    enabled: true,
    status: 'CONFIRMED',
    workspaceStatus: 'active',
  },
  {
    id: 'viewer@example.com',
    username: 'viewer@example.com',
    email: 'viewer@example.com',
    name: 'Viewer User',
    enabled: true,
    status: 'CONFIRMED',
    workspaceStatus: 'active',
  },
] satisfies ProjectUser[]

/** Project-scoped file controller shared by the file-view story. */
export const taskViewStoryProjectFiles = {
  ...fileArtifactsControllerFixture,
  approvals: [],
  scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
} satisfies FileArtifactsController
