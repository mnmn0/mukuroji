import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ResourceRequest } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkloadRequestList } from './WorkloadRequestList'

/** Creates a request fixture with the shared Team scope. */
function createRequest(overrides: Partial<ResourceRequest> & Pick<ResourceRequest, 'id' | 'title' | 'status'>): ResourceRequest {
  return {
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    skillIds: [],
    fromDate: '2026-08-03',
    toDate: '2026-08-07',
    requestedMinutes: 960,
    confidential: false,
    revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

const requests: ResourceRequest[] = [
  createRequest({ id: 'request-1', title: 'Launch support', status: 'partially-filled', projectId: 'project-1', role: 'QA', skillIds: ['testing', 'release'] }),
  createRequest({ id: 'request-2', title: 'Data migration review', status: 'open', fromDate: '2026-08-10', toDate: '2026-08-12', requestedMinutes: 480, confidential: true }),
  createRequest({ id: 'request-3', title: 'Old onboarding help', status: 'canceled', fromDate: '2026-07-20', toDate: '2026-07-24' }),
]

const meta = {
  title: 'Workload/WorkloadRequestList',
  component: WorkloadRequestList,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof WorkloadRequestList>

export default meta
/** Story object type for the resource request list stories. */
type Story = StoryObj<typeof meta>

/** Shows active requests first and a canceled request without actions. */
export const Default: Story = {
  args: {
    isSaving: false,
    onUpdate: async () => true,
    projects: [{ id: 'project-1', name: 'Customer onboarding' }],
    redactedCount: 1,
    requests,
    t: createTranslator('ja'),
  },
}

/** Shows the empty state. */
export const Empty: Story = {
  args: { ...Default.args, redactedCount: 0, requests: [] },
}

/** Keeps the inline forms within the phone width. */
export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
