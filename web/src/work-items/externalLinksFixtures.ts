import type {
  ConnectorInstallation,
  ExternalWorkItemLink,
} from '@mukuroji/contracts'

/**
 * External link Story と unit test で表示する connector account です。
 */
export const externalLinkInstallationFixtures = [
  {
    id: 'connector-github-product',
    category: 'source-control',
    provider: 'github',
    name: 'Product engineering',
    status: 'connected',
    scopes: ['repo:read', 'issues:write'],
    externalAccountId: 'mnmn0',
    externalAccountName: 'mnmn0',
    installedByUserId: 'user-minami',
    installedAt: '2026-05-10T04:00:00.000Z',
    updatedAt: '2026-07-18T01:50:00.000Z',
    lastSyncAt: '2026-07-18T01:49:00.000Z',
  },
  {
    id: 'connector-github-platform',
    category: 'source-control',
    provider: 'github',
    name: 'Platform engineering',
    status: 'connected',
    scopes: ['repo:read', 'issues:write'],
    externalAccountId: 'mukuroji-platform',
    externalAccountName: 'mukuroji-platform',
    installedByUserId: 'user-minami',
    installedAt: '2026-07-01T04:00:00.000Z',
    updatedAt: '2026-07-18T01:55:00.000Z',
    lastSyncAt: '2026-07-18T01:54:00.000Z',
  },
] satisfies ConnectorInstallation[]

/**
 * External link Story と unit test で表示する source resource です。
 */
export const externalWorkItemLinkFixtures = [
  {
    id: 'external-link-issue-29',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    installationId: 'connector-github-product',
    resourceType: 'issue',
    externalId: '29',
    externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
    displayKey: 'GH-29',
    syncDirection: 'bidirectional',
    syncStatus: 'synced',
    lastSyncedAt: '2026-07-18T01:49:00.000Z',
    createdAt: '2026-07-17T04:00:00.000Z',
    updatedAt: '2026-07-18T01:49:00.000Z',
  },
  {
    id: 'external-link-commit-api',
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    installationId: 'connector-github-platform',
    resourceType: 'commit',
    externalId: 'c0ffee29',
    externalUrl: 'https://github.com/mnmn0/mukuroji/commit/c0ffee29',
    displayKey: 'c0ffee2',
    syncDirection: 'outbound',
    syncStatus: 'pending',
    createdAt: '2026-07-18T01:52:00.000Z',
    updatedAt: '2026-07-18T01:52:00.000Z',
  },
] satisfies ExternalWorkItemLink[]
