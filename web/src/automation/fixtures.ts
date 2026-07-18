import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationExecution,
  type AutomationInboundWebhookEndpoint,
  type AutomationInboundWebhookSecretResponse,
  type AutomationRule,
  type AutomationTemplate,
  type AutomationTemplateApplication,
  type RecurringWork,
} from '@mukuroji/contracts'

const fixtureTimestamp = '2026-07-16T00:00:00.000Z'

/** Active inbound Webhook endpoint fixture です。 */
export const activeInboundWebhookEndpointFixture: AutomationInboundWebhookEndpoint = {
  createdAt: fixtureTimestamp,
  endpointUrl: 'https://api.example.com/api/automation/inbound-webhooks/opaque-release-hook',
  id: 'release-hook',
  name: 'Release events',
  opaqueEndpointId: 'opaque-release-hook',
  revision: 3,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  secretGeneration: 2,
  status: 'active',
  updatedAt: fixtureTimestamp,
  version: 3,
  workspaceId: 'workspace-demo',
}

/** Provisioning 中の inbound Webhook endpoint fixture です。 */
export const provisioningInboundWebhookEndpointFixture: AutomationInboundWebhookEndpoint = {
  ...activeInboundWebhookEndpointFixture,
  endpointUrl: 'https://api.example.com/api/automation/inbound-webhooks/opaque-rotating-hook',
  id: 'rotating-hook',
  name: 'Rotating events',
  opaqueEndpointId: 'opaque-rotating-hook',
  revision: 4,
  secretGeneration: 3,
  status: 'provisioning',
  version: 4,
}

/** Paused inbound Webhook endpoint fixture です。 */
export const pausedInboundWebhookEndpointFixture: AutomationInboundWebhookEndpoint = {
  ...activeInboundWebhookEndpointFixture,
  id: 'billing-hook',
  name: 'Billing events',
  opaqueEndpointId: 'opaque-billing-hook',
  endpointUrl: 'https://api.example.com/api/automation/inbound-webhooks/opaque-billing-hook',
  revision: 5,
  status: 'paused',
  version: 5,
}

/** Revoked inbound Webhook endpoint fixture です。 */
export const revokedInboundWebhookEndpointFixture: AutomationInboundWebhookEndpoint = {
  ...activeInboundWebhookEndpointFixture,
  id: 'legacy-hook',
  name: 'Legacy events',
  opaqueEndpointId: 'opaque-legacy-hook',
  endpointUrl: 'https://api.example.com/api/automation/inbound-webhooks/opaque-legacy-hook',
  revokedAt: fixtureTimestamp,
  revision: 8,
  status: 'revoked',
  version: 8,
}

/** Create/rotate 直後だけ利用する signing secret response fixture です。 */
export const inboundWebhookSecretResponseFixture: AutomationInboundWebhookSecretResponse = {
  endpoint: activeInboundWebhookEndpointFixture,
  signingSecret: 'whsec_storybook_one_time_only',
}

/** 有効な status rule fixture です。 */
export const activeAutomationRuleFixture: AutomationRule = {
  allowReentry: false,
  actions: [{
    body: 'レビューを開始しました。',
    type: 'comment',
  }],
  conditions: [{
    field: 'workItem.priority',
    operator: 'equals',
    type: 'field',
    value: 'high',
  }],
  createdAt: fixtureTimestamp,
  enabled: true,
  id: 'rule-review-started',
  name: 'レビュー開始を通知',
  maxChainDepth: 8,
  rateLimit: {
    maxExecutions: 60,
    windowSeconds: 60,
  },
  retryPolicy: {
    backoffMultiplier: 2,
    initialDelayMs: 1_000,
    maxAttempts: 3,
    maxDelayMs: 60_000,
  },
  revision: 4,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  trigger: {
    toStatusId: 'in-review',
    type: 'status',
  },
  updatedAt: fixtureTimestamp,
  version: 3,
  workspaceId: 'workspace-demo',
}

/** 停止中の webhook rule fixture です。 */
export const pausedAutomationRuleFixture: AutomationRule = {
  ...activeAutomationRuleFixture,
  actions: [{
    recipientMemberKeys: ['owner@example.com'],
    title: 'Webhook received',
    type: 'notify',
  }],
  enabled: false,
  id: 'rule-inbound-webhook',
  name: 'Webhook から Work Item を更新',
  revision: 2,
  trigger: {
    type: 'webhook',
    webhookId: 'release-hook',
  },
  version: 2,
}

/** Work Item template fixture です。 */
export const workItemAutomationTemplateFixture: Extract<
  AutomationTemplate,
  { kind: 'work-item' }
> = {
  createdAt: fixtureTimestamp,
  enabled: true,
  id: 'template-weekly-review',
  kind: 'work-item',
  name: '週次レビュー',
  payload: {
    priority: 'medium',
    title: '週次レビュー',
  },
  revision: 3,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  updatedAt: fixtureTimestamp,
  version: 2,
  workspaceId: 'workspace-demo',
}

/** Typed Project template fixture です。 */
export const projectAutomationTemplateFixture: Extract<
  AutomationTemplate,
  { kind: 'project' }
> = {
  createdAt: fixtureTimestamp,
  enabled: true,
  id: 'template-project-launch',
  kind: 'project',
  name: 'Launch project',
  payload: {
    nameEn: 'Launch readiness',
    nameJa: 'ローンチ準備',
    tone: 'purple',
  },
  revision: 2,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  updatedAt: fixtureTimestamp,
  version: 2,
  workspaceId: 'workspace-demo',
}

/** Status/transition matrix を含む Workflow template fixture です。 */
export const workflowAutomationTemplateFixture: Extract<
  AutomationTemplate,
  { kind: 'workflow' }
> = {
  createdAt: fixtureTimestamp,
  enabled: true,
  id: 'template-workflow-delivery',
  kind: 'workflow',
  name: 'Delivery workflow',
  payload: {
    id: 'delivery-template',
    initialStatusId: 'backlog',
    name: 'Delivery workflow',
    statuses: [
      { category: 'backlog', id: 'backlog', name: 'Backlog', sortOrder: 0 },
      { category: 'started', id: 'active', name: 'In progress', sortOrder: 1 },
      { category: 'completed', id: 'done', name: 'Done', sortOrder: 2 },
    ],
    transitions: [
      { fromStatusId: 'backlog', toStatusId: 'active' },
      { fromStatusId: 'active', toStatusId: 'done' },
    ],
  },
  revision: 4,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  updatedAt: fixtureTimestamp,
  version: 3,
  workspaceId: 'workspace-demo',
}

/** Project template application の成功 receipt fixture です。 */
export const projectTemplateApplicationFixture: AutomationTemplateApplication = {
  actorId: 'owner@example.com',
  createdAt: fixtureTimestamp,
  id: 'application-project-launch',
  kind: 'project',
  result: {
    kind: 'project',
    name: 'ローンチ準備',
    projectId: 'application-project-launch',
    teamId: 'core-team',
  },
  revision: 3,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  status: 'succeeded',
  target: { kind: 'project', teamId: 'core-team' },
  templateId: projectAutomationTemplateFixture.id,
  templateVersion: projectAutomationTemplateFixture.version,
  updatedAt: fixtureTimestamp,
  workspaceId: 'workspace-demo',
}

/** Workflow template application の成功 receipt fixture です。 */
export const workflowTemplateApplicationFixture: AutomationTemplateApplication = {
  actorId: 'owner@example.com',
  createdAt: fixtureTimestamp,
  id: 'application-workflow-delivery',
  kind: 'workflow',
  result: {
    kind: 'workflow',
    revision: 8,
    scopeId: 'core-team',
    scopeType: 'team',
  },
  revision: 2,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  status: 'succeeded',
  target: {
    expectedRevision: 0,
    kind: 'workflow',
    scopeId: 'core-team',
    scopeType: 'team',
  },
  templateId: workflowAutomationTemplateFixture.id,
  templateVersion: workflowAutomationTemplateFixture.version,
  updatedAt: fixtureTimestamp,
  workspaceId: 'workspace-demo',
}

/** DST 境界を含む recurring Work fixture です。 */
export const dstRecurringWorkFixture: RecurringWork = {
  createdAt: fixtureTimestamp,
  enabled: true,
  id: 'recurring-weekly-review',
  lastRunAt: '2026-03-01T14:00:00.000Z',
  name: 'ニューヨーク週次レビュー',
  nextRunAt: '2026-03-08T13:00:00.000Z',
  revision: 5,
  schedule: {
    catchUpPolicy: 'latest',
    daysOfWeek: [0],
    frequency: 'weekly',
    interval: 1,
    localTime: '09:00',
    startDate: '2026-03-01',
    timeZone: 'America/New_York',
  },
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  teamId: 'core-team',
  templateId: workItemAutomationTemplateFixture.id,
  templateVersion: workItemAutomationTemplateFixture.version,
  updatedAt: fixtureTimestamp,
  version: 4,
  workspaceId: 'workspace-demo',
}

/** Dead-letter に到達した execution fixture です。 */
export const deadLetterAutomationExecutionFixture: AutomationExecution = {
  actions: [{
    actionId: 'rule-outbound-webhook:v2:0',
    actionIndex: 0,
    attempts: 4,
    completedAt: '2026-07-16T00:04:00.000Z',
    errorCode: 'WebhookDeliveryFailed',
    errorMessage: 'The endpoint returned HTTP 503 after the final retry.',
    startedAt: fixtureTimestamp,
    status: 'failed',
  }],
  attempts: 4,
  completedAt: '2026-07-16T00:04:00.000Z',
  errorCode: 'RetryExhausted',
  errorMessage: 'The execution reached the retry limit and was moved to the dead-letter queue.',
  id: 'execution-dead-letter-1',
  retryable: true,
  ruleId: 'rule-outbound-webhook',
  ruleVersion: 2,
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  startedAt: fixtureTimestamp,
  status: 'dead-letter',
  triggerEventId: 'event-release-1',
  workspaceId: 'workspace-demo',
}
