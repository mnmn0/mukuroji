import type { Customer, CustomerDetail } from '@mukuroji/contracts'

/** Customer used by Customer stories and tests. */
export const customerFixture: Customer = {
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

/** Customer detail graph used by Customer stories and tests. */
export const customerDetailFixture: CustomerDetail = {
  customer: customerFixture,
  contacts: [{
    id: 'contact-1',
    workspaceId: 'workspace-1',
    customerId: customerFixture.id,
    name: 'Mina Example',
    email: 'mina@acme.example',
    role: 'Product lead',
    primary: true,
    status: 'active',
    revision: 1,
    createdAt: customerFixture.createdAt,
    updatedAt: customerFixture.updatedAt,
  }],
    requests: [{
    schemaVersion: 1,
    id: 'request-1',
    workspaceId: 'workspace-1',
    customerId: customerFixture.id,
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
      linkedAt: customerFixture.updatedAt,
        linkedBy: 'mina@example.com',
      }],
      projectLinks: [{
        projectId: 'project-1',
        linkedAt: customerFixture.updatedAt,
        linkedBy: 'mina@example.com',
      }],
    revision: 1,
    createdAt: customerFixture.updatedAt,
    updatedAt: customerFixture.updatedAt,
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
