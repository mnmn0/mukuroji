import type { Meta, StoryObj } from '@storybook/react-vite'
import type { Customer, CustomerDetail } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { CustomerDirectoryView } from './CustomerDirectoryView'

const customer: Customer = {
  schemaVersion: 1,
  id: 'customer-1',
  workspaceId: 'workspace-1',
  name: 'Acme Industries',
  domain: 'acme.example',
  tier: 'strategic',
  size: 'enterprise',
  status: 'active',
  health: 'watch',
  businessValue: 86,
  contactCount: 1,
  requestCount: 2,
  openRequestCount: 1,
  revision: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const detail: CustomerDetail = {
  customer,
  contacts: [{
    id: 'contact-1',
    workspaceId: 'workspace-1',
    customerId: customer.id,
    name: 'Mina Example',
    email: 'mina@acme.example',
    role: 'Product lead',
    primary: true,
    status: 'active',
    revision: 1,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  }],
    requests: [{
    schemaVersion: 1,
    id: 'request-1',
    workspaceId: 'workspace-1',
    customerId: customer.id,
    contactId: 'contact-1',
    source: { kind: 'portal', canNotify: true },
    originalMessage: 'Please add an export format for the quarterly review.',
    receivedAt: '2026-08-18T00:00:00.000Z',
    importance: 'high',
    status: 'in-progress',
      workItemLinks: [{
      teamId: 'team-1',
      workItemId: 'work-item-1',
      projectId: 'project-1',
      linkedAt: customer.updatedAt,
        linkedBy: 'mina@example.com',
      }],
      projectLinks: [{
        projectId: 'project-1',
        linkedAt: customer.updatedAt,
        linkedBy: 'mina@example.com',
      }],
    revision: 1,
    createdAt: customer.updatedAt,
    updatedAt: customer.updatedAt,
  }],
  workItems: [{
    teamId: 'team-1',
    workItemId: 'work-item-1',
    projectId: 'project-1',
    requestCount: 1,
    requestStates: ['in-progress'],
    lifecycle: 'in-progress',
  }],
  projects: [{
    projectId: 'project-1',
    requestCount: 1,
    requestStates: ['in-progress'],
  }],
}

const meta = {
  title: 'Customers/CustomerDirectoryView',
  component: CustomerDirectoryView,
  parameters: { layout: 'fullscreen' },
  decorators: [(Story) => <div className="min-h-screen bg-[var(--workbench-bg)] p-6"><Story /></div>],
  args: {
    canViewSensitiveData: true,
    customers: [customer],
    detail,
    errorMessage: undefined,
    filters: {},
    groupBy: undefined,
    isLoading: false,
    isSavingView: false,
    locale: 'en-US',
    onApplySavedView: () => undefined,
    onFiltersChange: () => undefined,
    onGroupByChange: () => undefined,
    onOpenProject: () => undefined,
    onOpenWorkItem: () => undefined,
    onRetry: () => undefined,
    onSaveView: () => undefined,
    onSearchChange: () => undefined,
    onSelectCustomer: () => undefined,
    search: '',
    t: createTranslator('en'),
    savedViews: [],
  },
} satisfies Meta<typeof CustomerDirectoryView>

export default meta

/** Story type for the Customer directory view. */
type Story = StoryObj<typeof meta>

/** Customer directory with contacts, source Requests, and a linked Work Item. */
export const Default: Story = {}

/** Empty state after a search returned no matching Customers. */
export const Empty: Story = {
  args: { customers: [], detail: undefined, onOpenProject: () => undefined, search: 'missing' },
}

/** Renders the directory for a member without sensitive-data access. */
export const Restricted: Story = {
  args: {
    canViewSensitiveData: false,
    search: '',
  },
}
