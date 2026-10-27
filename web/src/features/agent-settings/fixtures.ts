import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type AgentSettings,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { AgentSettingsTeam } from './ui/AgentSettingsPanelContainer'

/** Teams of the Storybook Workspace. */
export const agentSettingsTeamsFixture = [
  {
    id: 'team-platform',
    name: 'Platform',
    projects: [
      { id: 'project-api', name: 'Public API' },
      { id: 'project-console', name: 'Admin console' },
    ],
  },
  { id: 'team-growth', name: 'Growth', projects: [] },
] satisfies AgentSettingsTeam[]

/** Saved Agent settings of the Platform Team. */
export const agentSettingsFixture: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  teamId: 'team-platform',
  revision: 4,
  leaseMinutes: 45,
  allowTakeoverAfterLeaseExpiry: true,
  readyStatusIds: ['ready'],
  requireAcceptanceCriteria: true,
  acceptanceCriteriaFieldId: 'definition-of-done',
  brief: '## Platform\n\n- Run `bun run web:test` before reporting.\n- Keep changes small.',
  projectBriefs: {
    'project-api': 'Keep the Public API schema closed; publish new fields through the agent context.',
  },
  updatedAt: '2026-10-20T03:15:00.000Z',
  updatedBy: 'member-avery',
}

/** Work Item configuration of the Platform Team with two workflows and several custom fields. */
export const agentSettingsConfigurationFixture: WorkItemConfiguration = {
  scopeType: 'team',
  scopeId: 'team-platform',
  schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  revision: 3,
  workflow: {
    id: 'delivery',
    name: 'Delivery',
    initialStatusId: 'backlog',
    statuses: [
      { id: 'backlog', name: 'Backlog', category: 'backlog', sortOrder: 0 },
      { id: 'ready', name: 'Ready', category: 'unstarted', sortOrder: 1 },
      { id: 'active', name: 'In progress', category: 'started', sortOrder: 2 },
      { id: 'done', name: 'Done', category: 'completed', sortOrder: 3 },
    ],
    transitions: [],
  },
  workflows: [
    {
      id: 'incidents',
      name: 'Incidents',
      initialStatusId: 'triage',
      statuses: [
        { id: 'triage', name: 'Triage', category: 'unstarted', sortOrder: 0 },
        { id: 'mitigating', name: 'Mitigating', category: 'started', sortOrder: 1 },
        { id: 'resolved', name: 'Resolved', category: 'completed', sortOrder: 2 },
      ],
      transitions: [],
    },
  ],
  customFields: [
    { id: 'definition-of-done', name: 'Definition of done', type: 'text', sortOrder: 0, required: false },
    { id: 'story-points', name: 'Story points', type: 'number', sortOrder: 1, required: false },
    {
      id: 'checks',
      name: 'Required checks',
      type: 'multi-select',
      sortOrder: 2,
      required: false,
      options: [{ id: 'tests', name: 'Tests', sortOrder: 0 }],
    },
  ],
}
