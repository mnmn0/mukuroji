import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type CustomFieldValue,
  type ResolvedWorkItemConfiguration,
  type WorkItemConfiguration,
  type WorkItemRelation,
} from '@mukuroji/contracts'
import type { WorkItemPersonOption } from './WorkItemFieldsEditor'
import type { WorkItemRelationCandidate } from './WorkItemRelationsEditor'

/**
 * Workflow、全 custom field type、validation を含む Workspace 設定 fixture です。
 */
export const workspaceWorkItemConfigurationFixture = {
  scopeType: 'workspace',
  scopeId: 'workspace-demo',
  schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  revision: 7,
  updatedAt: '2026-07-12T09:30:00.000Z',
  workflow: {
    id: 'delivery-workflow',
    name: 'Product delivery',
    initialStatusId: 'backlog',
    statuses: [
      { id: 'backlog', name: 'Backlog', category: 'backlog', sortOrder: 0 },
      { id: 'ready', name: 'Ready', category: 'unstarted', sortOrder: 1 },
      { id: 'active', name: 'In progress', category: 'started', sortOrder: 2 },
      { id: 'review', name: 'In review', category: 'started', sortOrder: 3 },
      { id: 'done', name: 'Done', category: 'completed', sortOrder: 4 },
      { id: 'canceled', name: 'Canceled', category: 'canceled', sortOrder: 5 },
    ],
    transitions: [
      { fromStatusId: 'backlog', toStatusId: 'ready' },
      { fromStatusId: 'backlog', toStatusId: 'canceled' },
      { fromStatusId: 'ready', toStatusId: 'active' },
      { fromStatusId: 'ready', toStatusId: 'backlog' },
      { fromStatusId: 'active', toStatusId: 'review' },
      { fromStatusId: 'active', toStatusId: 'canceled' },
      { fromStatusId: 'review', toStatusId: 'active' },
      { fromStatusId: 'review', toStatusId: 'done' },
      { fromStatusId: 'done', toStatusId: 'active' },
      { fromStatusId: 'canceled', toStatusId: 'backlog' },
    ],
  },
  customFields: [
    {
      id: 'customer-impact',
      name: 'Customer impact',
      type: 'text',
      sortOrder: 0,
      required: true,
      validation: { minLength: 12, maxLength: 240, pattern: '\\S+' },
    },
    {
      id: 'story-points',
      name: 'Story points',
      type: 'number',
      sortOrder: 1,
      required: false,
      defaultValue: 3,
      validation: { min: 0, max: 100 },
    },
    {
      id: 'release-blocker',
      name: 'Release blocker',
      type: 'boolean',
      sortOrder: 2,
      required: false,
      defaultValue: false,
    },
    {
      id: 'target-date',
      name: 'Target date',
      type: 'date',
      sortOrder: 3,
      required: false,
    },
    {
      id: 'risk-level',
      name: 'Risk level',
      type: 'select',
      sortOrder: 4,
      required: true,
      defaultValue: 'moderate',
      options: [
        { id: 'low', name: 'Low', sortOrder: 0, color: 'green' },
        { id: 'moderate', name: 'Moderate', sortOrder: 1, color: 'amber' },
        { id: 'high', name: 'High', sortOrder: 2, color: 'red' },
      ],
    },
    {
      id: 'disciplines',
      name: 'Disciplines',
      type: 'multi-select',
      sortOrder: 5,
      required: false,
      defaultValue: ['frontend'],
      validation: { maxLength: 3 },
      options: [
        { id: 'frontend', name: 'Frontend', sortOrder: 0 },
        { id: 'backend', name: 'Backend', sortOrder: 1 },
        { id: 'design', name: 'Design', sortOrder: 2 },
        { id: 'research', name: 'Research', sortOrder: 3 },
      ],
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      type: 'person',
      sortOrder: 6,
      required: false,
    },
    {
      id: 'budget',
      name: 'Budget',
      type: 'currency',
      sortOrder: 7,
      required: false,
      currencyCode: 'JPY',
      validation: { min: 0, max: 10_000_000 },
      projectIds: ['refero'],
    },
    {
      id: 'estimate',
      name: 'Estimate',
      type: 'duration',
      sortOrder: 8,
      required: false,
      defaultValue: 8,
      durationUnit: 'hours',
      validation: { min: 0, max: 320 },
    },
    {
      id: 'weighted-score',
      name: 'Weighted score',
      type: 'formula',
      sortOrder: 9,
      required: false,
      formulaExpression: '{story-points} * 2',
    },
  ],
} satisfies WorkItemConfiguration

/**
 * Team が Workspace configuration を継承している解決結果 fixture です。
 */
export const inheritedWorkItemConfigurationFixture = {
  configuration: workspaceWorkItemConfigurationFixture,
  inheritedFrom: 'workspace',
} satisfies ResolvedWorkItemConfiguration

/**
 * Team 固有 override の編集状態を確認する configuration fixture です。
 */
export const teamWorkItemConfigurationFixture = {
  ...workspaceWorkItemConfigurationFixture,
  scopeType: 'team',
  scopeId: 'core-team',
  revision: 3,
  updatedAt: '2026-07-12T10:15:00.000Z',
  workflow: {
    ...workspaceWorkItemConfigurationFixture.workflow,
    id: 'core-team-delivery-workflow',
    name: 'Core team delivery',
  },
} satisfies WorkItemConfiguration

/**
 * Work Item form で field type ごとの描画を確認する値 fixture です。
 */
export const workItemCustomFieldValueFixture = {
  'customer-impact': 'Enterprise customers can complete setup without support.',
  'story-points': 8,
  'release-blocker': true,
  'target-date': '2026-07-24',
  'risk-level': 'moderate',
  disciplines: ['frontend', 'design'],
  reviewer: 'sato@example.com',
  budget: 1_200_000,
  estimate: 24,
  'weighted-score': 16,
} satisfies Readonly<Record<string, CustomFieldValue>>

/**
 * Person custom field の選択候補 fixture です。
 */
export const workItemPersonOptionFixtures = [
  { id: 'sato@example.com', name: '佐藤 花子', email: 'sato@example.com' },
  { id: 'suzuki@example.com', name: '鈴木 大輔', email: 'suzuki@example.com' },
  { id: 'lee@example.com', name: 'Alex Lee', email: 'lee@example.com' },
] satisfies readonly WorkItemPersonOption[]

/**
 * Reciprocal relation の各表示方向を含む relation fixture です。
 */
export const workItemRelationFixtures = [
  {
    sourceWorkItemId: 'WI-104',
    type: 'parent',
    targetWorkItemId: 'WI-100',
    createdAt: '2026-07-12T08:10:00.000Z',
  },
  {
    sourceWorkItemId: 'WI-104',
    type: 'blocks',
    targetWorkItemId: 'WI-112',
    createdAt: '2026-07-12T08:12:00.000Z',
  },
  {
    sourceWorkItemId: 'WI-104',
    type: 'related',
    targetWorkItemId: 'WI-118',
    createdAt: '2026-07-12T08:14:00.000Z',
  },
] satisfies readonly WorkItemRelation[]

/**
 * Relation editor が同一 Team 内から絞り込む Work Item 候補 fixture です。
 */
export const workItemRelationCandidateFixtures = [
  { id: 'WI-100', title: 'Onboarding journey baseline' },
  { id: 'WI-104', title: 'Reduce setup friction' },
  { id: 'WI-112', title: 'Release readiness review' },
  { id: 'WI-118', title: 'Support handoff audit' },
  { id: 'WI-121', title: 'Instrument activation funnel' },
  { id: 'WI-125', title: 'Refresh setup guidance' },
] satisfies readonly WorkItemRelationCandidate[]
