import type {
  ApiProblem,
  ImportDryRunReport,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import type {
  DeveloperPlatformResources,
  IssuedApiKeySecret,
  IssuedOAuthClientSecret,
  IssuedWebhookSigningSecret,
} from './api'
import type { DeveloperPlatformLabels } from './ui/DeveloperPlatformView'

const connectorReauthorizationProblem = {
  type: 'https://mukuroji.example/problems/connector-reauthorization',
  title: 'Connector authorization has expired',
  status: 409,
  code: 'conflict',
  detail: 'The provider authorization expired. Reconnect to resume synchronization.',
  requestId: 'request-connector-reauth',
  retryable: false,
} satisfies ApiProblem

const connectorConflictProblem = {
  type: 'https://mukuroji.example/problems/sync-conflict',
  title: 'A mapped resource changed on both sides',
  status: 409,
  code: 'conflict',
  detail: 'Choose which version should be used before synchronization resumes.',
  requestId: 'request-connector-conflict',
  retryable: false,
} satisfies ApiProblem

/**
 * Story と unit test で使う Developer Platform の表示文言です。
 */
export const developerPlatformLabelsFixture = {
  eyebrow: 'Developer platform',
  title: 'API & integrations',
  description:
    'Manage credentials, signed webhooks, external connectors, and safe Work Item transfers.',
  readOnly: 'Read only',
  loading: 'Loading developer platform',
  loadError: 'Developer platform settings could not be loaded.',
  operationError: 'The operation could not be completed. Review the input and try again.',
  retry: 'Try again',
  tabs: {
    credentials: 'Credentials',
    webhooks: 'Webhooks',
    connectors: 'Connectors',
    imports: 'Import & export',
  },
  statusLabels: {
    active: 'Active',
    cancelled: 'Cancelled',
    completed: 'Completed',
    conflict: 'Conflict',
    connected: 'Connected',
    degraded: 'Degraded',
    delivered: 'Delivered',
    disabled: 'Disabled',
    disconnected: 'Disconnected',
    expired: 'Expired',
    failed: 'Failed',
    ignored: 'Ignored',
    open: 'Open',
    paused: 'Paused',
    pending: 'Pending',
    queued: 'Queued',
    retrying: 'Retrying',
    resolved: 'Resolved',
    revoked: 'Revoked',
    running: 'Running',
    validating: 'Validating',
    'needs-reauth': 'Needs reauthorization',
  },
  scopeOptions: [
    {
      value: 'work-items:read',
      label: 'Read Work Items',
      description: 'Read Work Items that the credential owner can access.',
    },
    {
      value: 'work-items:write',
      label: 'Write Work Items',
      description: 'Create and update accessible Work Items.',
    },
    {
      value: 'work-items:delete',
      label: 'Delete Work Items',
      description: 'Delete accessible Work Items.',
    },
    {
      value: 'webhooks:read',
      label: 'Read webhooks',
      description: 'Inspect subscriptions and delivery logs.',
    },
    {
      value: 'webhooks:write',
      label: 'Manage webhooks',
      description: 'Create subscriptions and replay deliveries.',
    },
    {
      value: 'integrations:read',
      label: 'Read integrations',
      description: 'Inspect connector installations and external links.',
    },
    {
      value: 'integrations:write',
      label: 'Manage integrations',
      description: 'Connect providers and resolve synchronization conflicts.',
    },
    {
      value: 'imports:read',
      label: 'Read transfers',
      description: 'Inspect import and export jobs.',
    },
    {
      value: 'imports:write',
      label: 'Run transfers',
      description: 'Dry-run and commit Work Item imports.',
    },
  ],
  grantTypeOptions: [
    {
      value: 'client_credentials',
      label: 'Client credentials',
      description: 'Run trusted server-to-server automation.',
    },
  ],
  webhookEventOptions: [
    {
      value: 'work-item.created',
      label: 'Work Item created',
      description: 'A Work Item was created.',
    },
    {
      value: 'work-item.updated',
      label: 'Work Item updated',
      description: 'Fields or workflow state changed.',
    },
    {
      value: 'work-item.deleted',
      label: 'Work Item deleted',
      description: 'A Work Item was deleted.',
    },
    {
      value: 'external-link.updated',
      label: 'External link updated',
      description: 'A linked provider resource changed.',
    },
    {
      value: 'sync-conflict.created',
      label: 'Sync conflict created',
      description: 'Bidirectional synchronization needs a decision.',
    },
    {
      value: 'import.completed',
      label: 'Import completed',
      description: 'A committed import finished.',
    },
    {
      value: 'import.failed',
      label: 'Import failed',
      description: 'An import stopped with an error.',
    },
  ],
  connectorCatalog: [
    {
      provider: 'github',
      name: 'GitHub',
      description: 'Map repositories, issues, pull requests, commits, and deployments.',
      categoryLabel: 'Source control',
      scopes: ['repo:read', 'issues:write'],
      searchTerms: ['repository', 'issue', 'pull request', 'commit', 'deploy'],
    },
    {
      provider: 'slack',
      name: 'Slack',
      description: 'Route project updates and actionable conversations to channels.',
      categoryLabel: 'Chat',
      scopes: ['channels:read', 'chat:write'],
      searchTerms: ['workspace', 'channel', 'message'],
    },
    {
      provider: 'gmail',
      name: 'Gmail',
      description: 'Link messages and email threads to Work Items.',
      categoryLabel: 'Email',
      scopes: ['mail:read', 'mail:link'],
      searchTerms: ['mailbox', 'message', 'thread'],
    },
    {
      provider: 'google-calendar',
      name: 'Google Calendar',
      description: 'Map calendars and events to milestones and delivery dates.',
      categoryLabel: 'Calendar',
      scopes: ['calendar:read', 'events:link'],
      searchTerms: ['calendar', 'event', 'meeting'],
    },
    {
      provider: 'google-drive',
      name: 'Google Drive',
      description: 'Map shared drives and folders to project files.',
      categoryLabel: 'Cloud storage',
      scopes: ['drive:read', 'files:link'],
      searchTerms: ['drive', 'folder', 'file'],
    },
  ],
  importFieldOptions: [
    {
      value: 'title',
      label: 'Title',
      description: 'Required Work Item title.',
    },
    {
      value: 'description',
      label: 'Description',
      description: 'Markdown Work Item description.',
    },
    {
      value: 'status',
      label: 'Status',
      description: 'Configured workflow state.',
    },
    {
      value: 'priority',
      label: 'Priority',
      description: 'Configured priority value.',
    },
    {
      value: 'assignee',
      label: 'Assignee',
      description: 'Workspace member identifier.',
    },
  ],
  tableHeaders: {
    account: 'Account',
    actions: 'Actions',
    attempts: 'Attempts',
    created: 'Created',
    creator: 'Creator',
    event: 'Event',
    expiry: 'Expiry',
    failures: 'Consecutive failures',
    fingerprint: 'Key fingerprint',
    lastDelivery: 'Last delivery',
    lastSync: 'Last sync',
    lastUsed: 'Last used',
    name: 'Name',
    response: 'Response',
    row: 'Row',
    scopes: 'Scopes',
    status: 'Status',
    updated: 'Updated',
  },
  actions: {
    addAccount: 'Add account',
    addMapping: 'Add mapping',
    cancel: 'Cancel',
    commitImport: 'Commit import',
    connect: 'Connect',
    connectAgain: 'Connect again',
    chooseResolution: 'Choose a resolution',
    createApiKey: 'Create API key',
    createOAuthApp: 'Register OAuth app',
    createWebhook: 'Add webhook',
    disconnect: 'Disconnect',
    dryRun: 'Run validation',
    'export-csv': 'Export CSV',
    'export-json': 'Export JSON',
    'keep-local': 'Keep mukuroji',
    'keep-remote': 'Keep provider',
    ignore: 'Ignore this conflict',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    merge: 'Merge fields',
    reauthorize: 'Reconnect',
    removeMapping: 'Remove',
    replay: 'Replay',
    resolve: 'Resolve conflict',
    revoke: 'Revoke',
    rotate: 'Rotate secret',
    'submit-api-key': 'Create API key',
    'submit-oauth-app': 'Register app',
    'submit-webhook': 'Create webhook',
  },
  fields: {
    conflictResolution: 'Resolution',
    detectedAt: 'Detected',
    events: 'Events',
    expiry: 'Expiry date',
    grantTypes: 'Grant types',
    externalLink: 'External link',
    externalRevision: 'Provider revision',
    externalValue: 'Provider value',
    importFile: 'Source file',
    importProject: 'Default project',
    importTeam: 'Destination team',
    localRevision: 'mukuroji revision',
    localValue: 'mukuroji value',
    mergedValues: 'Merged JSON values',
    name: 'Name',
    resourceSearch: 'Search resource mappings',
    revisions: 'Revisions',
    scopes: 'Scopes',
    sourceField: 'Source field',
    targetField: 'Work Item field',
    url: 'Endpoint URL',
    webhookTeams: 'Allowed teams',
    workItem: 'Work Item',
  },
  placeholders: {
    apiKeyName: 'Production automation',
    importProject: 'No default project',
    oauthName: 'Reporting integration',
    resourceSearch: 'Search repositories, channels, calendars, folders…',
    sourceField: 'CSV header or JSON path',
    targetField: 'Choose a Work Item field',
    webhookName: 'Production event sink',
    webhookUrl: 'https://example.com/webhooks/mukuroji',
  },
  headings: {
    apiKeys: 'API keys',
    apiKeysEmpty: 'No API keys yet',
    connectors: 'Connector catalog',
    connectorSearchEmpty: 'No matching resources',
    'create-api-key': 'Create an API key',
    'create-oauth-app': 'Register an OAuth app',
    'create-webhook': 'Create a signed webhook',
    deliveries: 'Delivery log',
    deliveriesEmpty: 'No deliveries yet',
    exports: 'Export Work Items',
    importReport: 'Dry-run report',
    imports: 'Import Work Items',
    mapping: 'Field mapping',
    oauthApps: 'OAuth apps',
    oauthAppsEmpty: 'No OAuth apps yet',
    'source-csv': 'CSV file',
    'source-json': 'JSON file',
    syncConflicts: 'Sync conflicts',
    syncConflictsEmpty: 'No sync conflicts',
    webhooks: 'Webhook subscriptions',
    webhooksEmpty: 'No webhook subscriptions yet',
  },
  helpText: {
    apiKeys:
      'Use a named, scoped key for each automation. The complete key is never shown in this ledger.',
    apiKeysEmpty:
      'Create a narrowly scoped key for your first server-side integration.',
    connectorConflict:
      'Synchronization is paused. Review the field differences in the sync conflict list above to recover it.',
    connectorCount: '{count} accounts',
    connectors:
      'Search providers and the resources they map, then connect or recover an installation.',
    connectorSearchEmpty:
      'Try a provider name or resource such as repository, channel, calendar, or folder.',
    disconnectConfirm:
      'Disconnect {name}? Synchronization for its external links will be paused.',
    conflictResolveConfirm:
      'Resolve the conflict for Work Item {workItem} using “{resolution}”? This may change synchronized values.',
    'create-api-key':
      'Choose only the permissions this automation needs. You can rotate or revoke it later.',
    'create-oauth-app':
      'Choose the smallest scopes and an expiry for this server-to-server client.',
    'create-webhook':
      'Choose a delivery URL and the events it should receive.',
    deliveries:
      'Each attempt is auditable. Failed deliveries can be replayed without creating another event.',
    deliveriesEmpty:
      'Delivery attempts appear after a subscribed event occurs.',
    exports:
      'Download the Work Items you can access using the same permission model as the UI.',
    importPending: 'The import is still being prepared.',
    importReadOnly:
      'You can review prior jobs, but your role cannot start an import.',
    importReport:
      'Commit is enabled only after every row passes validation.',
    imports:
      'Choose a source, map fields, validate every row, then explicitly commit.',
    installedConnector:
      'Provider accounts installed in this Workspace and their synchronization state.',
    mapping:
      'Map source headers or JSON paths to canonical or custom Work Item fields.',
    mergedValues:
      'Enter the chosen value for each field as JSON. Wrap string values in double quotes.',
    mergeInvalid:
      'A merged value contains invalid JSON. Review the input.',
    never: 'Never',
    noConnectorAccounts: 'No accounts have been connected for this provider.',
    noExpiry: 'No expiry',
    noFile: 'No file selected',
    notAvailable: 'Not available',
    oauthApps:
      'OAuth apps provide server-to-server access with the client credentials grant.',
    oauthAppsEmpty:
      'Register an app when an integration needs OAuth authorization.',
    pending: 'Pending',
    revokeConfirm:
      'Revoke this credential? Integrations using it may stop immediately.',
    secretCopyError:
      'The secret could not be copied to the clipboard. Select the value and copy it manually.',
    selectionRequired: 'Select at least one option.',
    'source-csv':
      'Best for tabular migrations with a stable header row.',
    'source-json':
      'Best for nested source data and structured custom fields.',
    syncConflicts:
      'Compare mukuroji and provider values, then choose a recovery for each conflict ID.',
    syncConflictsEmpty:
      'No bidirectional synchronization is waiting for a decision.',
    syncConflictsError:
      'Sync conflicts could not be loaded. Try again.',
    syncConflictsLoadMoreError:
      'More sync conflicts could not be loaded. Previously loaded conflicts are still shown.',
    syncConflictsLoading: 'Loading sync conflicts',
    webhookDelivery:
      'Deliveries use a stable event ID, exponential backoff, and an HMAC signature.',
    webhookSigning:
      'Verify the timestamped HMAC signature before processing a payload. Signing secrets are shown only once.',
    webhooks:
      'Subscribe only to the events the endpoint needs and monitor every attempt.',
    webhooksEmpty:
      'Add an HTTPS endpoint to begin receiving signed events.',
  },
  secretTitles: {
    'api-key': 'Copy the API key now',
    'oauth-app': 'Copy the client secret now',
    webhook: 'Copy the signing secret now',
  },
  secretDescriptions: {
    'api-key': 'Use this value as the Bearer credential for API requests.',
    'oauth-app': 'Store this value in the OAuth client server, never in browser code.',
    webhook: 'Use this value to verify each delivery signature.',
  },
  secretWarning:
    'This secret is displayed once. Store it securely before closing this dialog.',
  secretStoredConfirmation: 'I stored this secret safely',
  copySecret: 'Copy secret',
  copiedSecret: 'Copied',
  closeDialog: 'Close',
  importReportSummary:
    '{valid} of {total} rows are valid. {invalid} rows need attention.',
} satisfies DeveloperPlatformLabels

/**
 * API key 作成 Story で一度だけ返す secret response です。
 */
export const issuedApiKeySecretFixture = {
  apiKey: {
    id: 'api-key-story-issued',
    name: 'Story automation',
    prefix: 'mk_live_••••c9f2',
    scopes: ['work-items:read'],
    status: 'active',
    createdByUserId: 'user-minami',
    createdAt: '2026-07-18T02:00:00.000Z',
    expiresAt: '2026-10-16T02:00:00.000Z',
  },
  secret: 'mk_live_story_once_7YH3pQ0f',
} satisfies IssuedApiKeySecret

/**
 * OAuth app 作成 Story で一度だけ返す secret response です。
 */
export const issuedOAuthClientSecretFixture = {
  oauthApp: {
    id: 'oauth-story-issued',
    name: 'Story OAuth app',
    clientId: 'mukuroji_client_story',
    grantTypes: ['client_credentials'],
    scopes: ['work-items:read'],
    status: 'active',
    createdByUserId: 'user-minami',
    createdAt: '2026-07-18T02:00:00.000Z',
    updatedAt: '2026-07-18T02:00:00.000Z',
    expiresAt: '2026-10-16T02:00:00.000Z',
  },
  clientSecret: 'oauth_story_once_F9s2kLm3',
} satisfies IssuedOAuthClientSecret

/**
 * Webhook 作成 Story で一度だけ返す signing secret response です。
 */
export const issuedWebhookSigningSecretFixture = {
  subscription: {
    id: 'webhook-story-issued',
    name: 'Story webhook',
    url: 'https://example.com/webhooks/mukuroji',
    createdByUserId: 'user-minami',
    teamIds: ['team-product'],
    eventTypes: ['work-item.updated'],
    scopes: ['work-items:read'],
    status: 'active',
    createdAt: '2026-07-18T02:00:00.000Z',
    updatedAt: '2026-07-18T02:00:00.000Z',
    failureCount: 0,
  },
  signingSecret: 'whsec_story_once_9dD3aP',
} satisfies IssuedWebhookSigningSecret

/**
 * 全 row が検証を通過した import dry-run report fixture です。
 */
export const successfulImportDryRunReportFixture = {
  valid: true,
  totalRows: 24,
  validRows: 24,
  invalidRows: 0,
  errors: [],
  sample: [
    {
      row: 1,
      input: {
        summary: 'Ship the public API',
      },
      mapped: {
        title: 'Ship the public API',
      },
      valid: true,
      errors: [],
    },
  ],
} satisfies ImportDryRunReport

/**
 * 未解決と解決済みの field 差分を含む sync conflict fixture です。
 */
export const developerSyncConflictsFixture = [
  {
    id: 'sync-conflict-github-title',
    externalLinkId: 'external-link-github-issue-29',
    workItemId: 'work-item-public-api',
    localRevision: 18,
    externalRevision: 'W/"github-issue-29-12"',
    fields: [
      {
        field: 'title',
        localValue: 'Ship the public API',
        externalValue: 'Release public API v1',
      },
      {
        field: 'priority',
        localValue: 'high',
        externalValue: 'critical',
      },
    ],
    status: 'open',
    detectedAt: '2026-07-18T01:51:00.000Z',
  },
  {
    id: 'sync-conflict-github-description',
    externalLinkId: 'external-link-github-issue-18',
    workItemId: 'work-item-webhooks',
    localRevision: 9,
    externalRevision: 'W/"github-issue-18-7"',
    fields: [
      {
        field: 'description',
        localValue: 'Verify signed webhook delivery.',
        externalValue: 'Verify HMAC signatures before processing.',
      },
    ],
    status: 'resolved',
    detectedAt: '2026-07-17T04:20:00.000Z',
    resolvedAt: '2026-07-17T04:24:00.000Z',
    resolvedByUserId: 'user-minami',
  },
] satisfies WorkItemSyncConflict[]

/**
 * 標準の credential、delivery、connector、import を含む aggregate fixture です。
 */
export const developerPlatformResourcesFixture = {
  capabilities: {
    canManageCredentials: true,
    canManageWebhooks: true,
    canManageIntegrations: true,
    canImport: true,
    canExport: true,
  },
  apiKeys: [
    {
      id: 'api-key-production',
      name: 'Production automation',
      prefix: 'mk_live_••••7b91',
      scopes: ['work-items:read', 'work-items:write'],
      status: 'active',
      createdByUserId: 'user-minami',
      createdAt: '2026-05-02T04:30:00.000Z',
      expiresAt: '2026-08-02T04:30:00.000Z',
      lastUsedAt: '2026-07-18T01:42:00.000Z',
    },
    {
      id: 'api-key-audit',
      name: 'Audit export',
      prefix: 'mk_live_••••2fa4',
      scopes: ['work-items:read', 'imports:read'],
      status: 'active',
      createdByUserId: 'user-sato',
      createdAt: '2026-06-10T08:15:00.000Z',
    },
  ],
  oauthApps: [
    {
      id: 'oauth-reporting',
      name: 'Reporting portal',
      clientId: 'mukuroji_client_reporting_01',
      grantTypes: ['client_credentials'],
      scopes: ['work-items:read'],
      status: 'active',
      createdByUserId: 'user-minami',
      createdAt: '2026-06-01T06:00:00.000Z',
      updatedAt: '2026-07-12T03:20:00.000Z',
      expiresAt: '2026-10-01T23:59:59.999Z',
      lastUsedAt: '2026-07-18T00:20:00.000Z',
    },
  ],
  webhookSubscriptions: [
    {
      id: 'webhook-production',
      name: 'Production event sink',
      url: 'https://events.example.com/hooks/mukuroji',
      createdByUserId: 'user-minami',
      teamIds: ['team-product'],
      eventTypes: ['work-item.created', 'work-item.updated', 'import.failed'],
      scopes: ['work-items:read'],
      status: 'active',
      createdAt: '2026-06-03T05:00:00.000Z',
      updatedAt: '2026-07-17T11:00:00.000Z',
      lastDeliveryAt: '2026-07-18T01:58:00.000Z',
      failureCount: 0,
    },
  ],
  webhookDeliveries: [
    {
      id: 'delivery-success',
      subscriptionId: 'webhook-production',
      eventId: 'event-1002',
      eventType: 'work-item.updated',
      status: 'delivered',
      attempts: 1,
      responseStatus: 204,
      deliveredAt: '2026-07-18T01:58:01.000Z',
      createdAt: '2026-07-18T01:58:00.000Z',
      updatedAt: '2026-07-18T01:58:01.000Z',
    },
  ],
  connectors: [
    {
      id: 'connector-github',
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
  ],
  imports: [
    {
      id: 'import-ready',
      format: 'csv',
      teamId: 'team-product',
      assignedProjectId: 'project-mukuroji',
      status: 'completed',
      mapping: [
        { sourceField: 'summary', targetField: 'title', required: true },
        { sourceField: 'details', targetField: 'description' },
      ],
      dryRun: true,
      createdByUserId: 'user-minami',
      createdAt: '2026-07-17T08:00:00.000Z',
      startedAt: '2026-07-17T08:00:01.000Z',
      completedAt: '2026-07-17T08:00:04.000Z',
      report: {
        totalRows: 24,
        validRows: 24,
        invalidRows: 0,
        errors: [],
      },
    },
  ],
} satisfies DeveloperPlatformResources

/**
 * 初回利用時の empty state aggregate fixture です。
 */
export const emptyDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  apiKeys: [],
  oauthApps: [],
  webhookSubscriptions: [],
  webhookDeliveries: [],
  connectors: [],
  imports: [],
} satisfies DeveloperPlatformResources

/**
 * 全 mutation capability を無効にした参照専用 aggregate fixture です。
 */
export const readOnlyDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  capabilities: {
    canManageCredentials: false,
    canManageWebhooks: false,
    canManageIntegrations: false,
    canImport: false,
    canExport: false,
  },
} satisfies DeveloperPlatformResources

/**
 * Replay 可能な delivery failure を含む aggregate fixture です。
 */
export const deliveryFailureDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  webhookSubscriptions: developerPlatformResourcesFixture.webhookSubscriptions.map(
    (subscription) => ({
      ...subscription,
      failureCount: 3,
    }),
  ),
  webhookDeliveries: [
    {
      id: 'delivery-failed',
      subscriptionId: 'webhook-production',
      eventId: 'event-1003',
      eventType: 'work-item.updated',
      status: 'failed',
      attempts: 8,
      responseStatus: 503,
      createdAt: '2026-07-18T01:59:00.000Z',
      updatedAt: '2026-07-18T02:04:00.000Z',
    },
    ...developerPlatformResourcesFixture.webhookDeliveries,
  ],
} satisfies DeveloperPlatformResources

/**
 * Reconnect が必要な connector を含む aggregate fixture です。
 */
export const needsReauthorizationDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  connectors: [
    {
      ...developerPlatformResourcesFixture.connectors[0],
      status: 'needs-reauth',
      lastError: connectorReauthorizationProblem,
      reauthorizationUrl: '/oauth/connectors/github/reauthorize',
    },
  ],
} satisfies DeveloperPlatformResources

/**
 * 同一 provider の複数 account と切断済み installation を含む fixture です。
 */
export const multipleConnectorAccountsDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  connectors: [
    ...developerPlatformResourcesFixture.connectors,
    {
      ...developerPlatformResourcesFixture.connectors[0],
      id: 'connector-github-archive',
      name: 'Archived engineering account',
      status: 'disconnected',
      externalAccountId: 'mnmn0-archive',
      externalAccountName: 'mnmn0-archive',
      updatedAt: '2026-07-17T01:50:00.000Z',
    },
    {
      ...developerPlatformResourcesFixture.connectors[0],
      id: 'connector-gitlab-platform',
      provider: 'gitlab',
      name: 'GitLab platform account',
      externalAccountId: 'mukuroji-gitlab',
      externalAccountName: 'mukuroji-gitlab',
      updatedAt: '2026-07-18T01:52:00.000Z',
    },
  ],
} satisfies DeveloperPlatformResources

/**
 * Resource mapping conflict を含む aggregate fixture です。
 */
export const connectorConflictDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  connectors: [
    {
      ...developerPlatformResourcesFixture.connectors[0],
      status: 'conflict',
      lastError: connectorConflictProblem,
    },
  ],
} satisfies DeveloperPlatformResources

/**
 * Row-level dry-run error を含む aggregate fixture です。
 */
export const importDryRunErrorDeveloperPlatformResourcesFixture = {
  ...developerPlatformResourcesFixture,
  imports: [
    {
      id: 'import-validation-failed',
      format: 'csv',
      teamId: 'team-product',
      assignedProjectId: 'project-mukuroji',
      status: 'failed',
      mapping: [
        { sourceField: 'summary', targetField: 'title', required: true },
        { sourceField: 'owner', targetField: 'assignee' },
      ],
      dryRun: true,
      createdByUserId: 'user-minami',
      createdAt: '2026-07-18T01:00:00.000Z',
      startedAt: '2026-07-18T01:00:01.000Z',
      completedAt: '2026-07-18T01:00:02.000Z',
      report: {
        totalRows: 24,
        validRows: 21,
        invalidRows: 3,
        errors: [
          {
            row: 4,
            field: 'summary',
            code: 'required',
            message: 'A title is required.',
          },
          {
            row: 11,
            field: 'owner',
            code: 'unknown_member',
            message: 'No active Workspace member matches this value.',
          },
          {
            row: 19,
            field: 'owner',
            code: 'unknown_member',
            message: 'No active Workspace member matches this value.',
          },
        ],
      },
    },
  ],
} satisfies DeveloperPlatformResources
