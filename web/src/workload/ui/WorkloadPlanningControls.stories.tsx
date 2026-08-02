import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorkloadSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkloadPlanningControls } from './WorkloadPlanningControls'

const snapshot: WorkloadSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  fromDate: '2026-08-03',
  toDate: '2026-08-14',
  granularity: 'day',
  members: [],
  requests: [],
  assignments: [],
  redactedAssignmentCount: 0,
  redactedRequestCount: 0,
  revision: 4,
  generatedAt: '2026-08-02T00:00:00.000Z',
}

const meta = {
  title: 'Workload/WorkloadPlanningControls',
  component: WorkloadPlanningControls,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkloadPlanningControls>

export default meta
/** Story object type for the workload planning controls stories. */
type Story = StoryObj<typeof meta>

/** Displays the profile, absence, request, assignment, and what-if forms. */
export const Default: Story = {
  args: {
    accessToken: 'storybook-access-token',
    members: [
      { id: 'hana', name: 'Hanako Sato', email: 'hana@example.com' },
      { id: 'mike', name: 'Mike Chen', email: 'mike@example.com' },
    ],
    onSaved: () => undefined,
    projects: [
      { id: 'project-1', name: 'Customer onboarding' },
      { id: 'project-2', name: 'Internal platform' },
    ],
    snapshot,
    t: createTranslator('en'),
    teamId: 'team-1',
  },
}
