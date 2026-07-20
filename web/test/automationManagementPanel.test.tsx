import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AutomationManagementPanel,
  AutomationTemplateApplicationEditor,
} from '../src/automation/ui/AutomationManagementPanel'
import { createTranslator } from '../src/shared/i18n/i18n'
import { loadAutomationManagementData } from '../src/automation/managementData'
import {
  AutomationInboundWebhooksPanel,
  AutomationWebhookSecretNotice,
} from '../src/automation/ui/AutomationInboundWebhooksPanel'
import { reduceAutomationWebhookSecret } from '../src/automation/model/webhookSecretState'
import {
  AutomationRuleEditor,
  AutomationTemplateEditor,
  AutomationTemplateUpdateEditor,
} from '../src/automation/ui/AutomationEditors'
import { createMutationRequestRunner } from '../src/shared/api/mutationHeaders'
import {
  createAutomationTemplateEditorInput,
  createAutomationConditions,
  createDefaultAutomationWorkflowTemplatePayload,
  createAutomationScheduleTrigger,
  isAutomationActionConfigurationValid,
  isAutomationProjectTemplatePayloadValid,
  isAutomationScheduleConfigurationValid,
  isAutomationTriggerConfigurationValid,
  isAutomationWorkflowTemplatePayloadValid,
  parseAutomationTemplatePayload,
} from '../src/automation/model/editorValidation'
import { submitAutomationEditorCreate } from '../src/automation/model/editorSubmission'
import { runAutomationManagementMutation } from '../src/automation/mutations/runAutomationManagementMutation'
import { resolveAutomationManagementTabTarget } from '../src/automation/model/tabs'
import { refreshAutomationTemplateApplication } from '../src/automation/model/templateApplicationRefresh'
import {
  activeAutomationRuleFixture,
  activeInboundWebhookEndpointFixture,
  deadLetterAutomationExecutionFixture,
  dstRecurringWorkFixture,
  pausedAutomationRuleFixture,
  pausedInboundWebhookEndpointFixture,
  provisioningInboundWebhookEndpointFixture,
  projectAutomationTemplateFixture,
  projectTemplateApplicationFixture,
  inboundWebhookSecretResponseFixture,
  revokedInboundWebhookEndpointFixture,
  workflowAutomationTemplateFixture,
  workflowTemplateApplicationFixture,
  workItemAutomationTemplateFixture,
} from '../src/automation/fixtures'

const teams = [{ id: 'core-team', name: 'Core team' }]

describe('AutomationManagementPanel', () => {
  test('reuses the idempotency context when create succeeds but refresh fails', async () => {
    const failure = new Error('Refresh failed')
    const requestContexts: Array<{ idempotencyKey: string; correlationId: string }> = []
    let reported: unknown
    let refreshCalls = 0
    const runner = createMutationRequestRunner(() => ({
      correlationId: 'correlation-1',
      idempotencyKey: 'idempotency-1',
    }))
    const run = () => runAutomationManagementMutation(
      runner,
      'rule:create',
      '{"name":"Release rule"}',
      async (context) => {
        requestContexts.push(context)
      },
      async () => {
        refreshCalls += 1
        if (refreshCalls === 1) throw failure
      },
      (error) => {
        reported = error
      },
    )

    await expect(run()).rejects.toBe(failure)
    await expect(run()).resolves.toBeUndefined()

    expect(reported).toBe(failure)
    expect(refreshCalls).toBe(2)
    expect(requestContexts).toHaveLength(2)
    expect(requestContexts[0]).toBe(requestContexts[1])
    expect(requestContexts.map((context) => context.idempotencyKey)).toEqual([
      'idempotency-1',
      'idempotency-1',
    ])
  })

  test('uses roving tab stops and wraps keyboard navigation across visible tabs', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        canViewWebhooks={false}
        executions={[]}
        initialTab="templates"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
      />,
    )
    const tabMarkup = (tab: 'rules' | 'templates' | 'recurring' | 'runs') => {
      const markerIndex = html.indexOf(`data-testid="automation-tab-${tab}"`)
      return html.slice(
        html.lastIndexOf('<button', markerIndex),
        html.indexOf('</button>', markerIndex),
      )
    }
    const visibleTabs = ['rules', 'templates', 'recurring', 'runs'] as const

    expect(tabMarkup('rules')).toContain('aria-selected="false"')
    expect(tabMarkup('rules')).toContain('tabindex="-1"')
    expect(tabMarkup('templates')).toContain('aria-selected="true"')
    expect(tabMarkup('templates')).toContain('tabindex="0"')
    expect(tabMarkup('recurring')).toContain('tabindex="-1"')
    expect(tabMarkup('runs')).toContain('tabindex="-1"')
    expect(resolveAutomationManagementTabTarget('rules', 'ArrowLeft', visibleTabs))
      .toBe('runs')
    expect(resolveAutomationManagementTabTarget('runs', 'ArrowRight', visibleTabs))
      .toBe('rules')
    expect(resolveAutomationManagementTabTarget('recurring', 'Home', visibleTabs))
      .toBe('rules')
    expect(resolveAutomationManagementTabTarget('templates', 'End', visibleTabs))
      .toBe('runs')
    expect(resolveAutomationManagementTabTarget('templates', 'Enter', visibleTabs))
      .toBeUndefined()
  })

  test('localizes known trigger, action, and status identifiers while retaining safe fallbacks', () => {
    const japaneseRuleHtml = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        locale="ja"
        recurringWork={[]}
        rules={[activeAutomationRuleFixture]}
        teams={teams}
        templates={[]}
      />,
    )
    const englishRuleHtml = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        locale="en"
        recurringWork={[]}
        rules={[activeAutomationRuleFixture]}
        teams={teams}
        templates={[]}
      />,
    )
    const executionHtml = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[deadLetterAutomationExecutionFixture]}
        initialTab="runs"
        locale="ja"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
      />,
    )

    expect(japaneseRuleHtml).toContain('トリガー: ステータス変更')
    expect(japaneseRuleHtml).toContain('アクション: コメントを追加')
    expect(japaneseRuleHtml).toContain('>有効</span>')
    expect(englishRuleHtml).toContain('Trigger: Status changed')
    expect(englishRuleHtml).toContain('Action: Add comment')
    expect(englishRuleHtml).toContain('>Active</span>')
    expect(executionHtml).toContain('>デッドレター</span>')
    expect(executionHtml).toContain('>失敗</span>')
    expect(executionHtml).toContain('rule outbound webhook:v2:0')
  })

  test('catches template application refresh failures and restores refreshing state', async () => {
    const errorChanges: Array<string | undefined> = []
    const refreshingChanges: boolean[] = []
    const applications: typeof projectTemplateApplicationFixture[] = []
    const errorMessage = createTranslator('ja')(
      'automation.template.application.refreshError',
    )

    await expect(refreshAutomationTemplateApplication({
      applicationId: projectTemplateApplicationFixture.id,
      errorMessage,
      onErrorChange: (message) => errorChanges.push(message),
      onRefresh: async () => {
        throw new Error('Refresh failed')
      },
      onRefreshingChange: (isRefreshing) => refreshingChanges.push(isRefreshing),
      onSuccess: (application) => applications.push(application),
    })).resolves.toBeUndefined()

    expect(errorChanges).toEqual([
      undefined,
      'Application receipt の状態を更新できませんでした。もう一度お試しください。',
    ])
    expect(refreshingChanges).toEqual([true, false])
    expect(applications).toEqual([])

    await refreshAutomationTemplateApplication({
      applicationId: projectTemplateApplicationFixture.id,
      errorMessage: createTranslator('en')('automation.template.application.refreshError'),
      onErrorChange: (message) => errorChanges.push(message),
      onRefresh: async () => projectTemplateApplicationFixture,
      onRefreshingChange: (isRefreshing) => refreshingChanges.push(isRefreshing),
      onSuccess: (application) => applications.push(application),
    })

    expect(errorChanges.at(-1)).toBeUndefined()
    expect(refreshingChanges.slice(-2)).toEqual([true, false])
    expect(applications).toEqual([projectTemplateApplicationFixture])
  })

  test('shows all trigger and action choices plus active and paused rule controls', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        locale="en"
        recurringWork={[]}
        rules={[activeAutomationRuleFixture, pausedAutomationRuleFixture]}
        teams={teams}
        templates={[workItemAutomationTemplateFixture]}
        onCreateRule={async () => undefined}
        onToggleRule={async () => undefined}
      />,
    )

    for (const label of [
      'Status changed',
      'Assignee changed',
      'Due date changed or reached',
      'Custom field changed',
      'Comment added',
      'Form submitted',
      'Webhook received',
      'Schedule',
      'Assign member',
      'Move to project',
      'Update fields',
      'Create Work Item',
      'Add comment',
      'Send notification',
      'Request approval',
      'Send webhook',
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('data-testid="automation-rule-create"')
    expect(html).toContain('data-testid="automation-rule-condition-field" value=""')
    expect(html).toContain('data-testid="automation-rule-action-configuration" required=""')
    expect(html).toContain('Pause')
    expect(html).toContain('Activate')
  })

  test('offers only active inbound Webhook endpoints in the rule trigger selector', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="webhook"
        locale="en"
        webhookEndpoints={[
          activeInboundWebhookEndpointFixture,
          pausedInboundWebhookEndpointFixture,
          revokedInboundWebhookEndpointFixture,
        ]}
        onCreate={async () => undefined}
      />,
    )

    expect(html).toContain('data-testid="automation-rule-webhook-endpoint"')
    expect(html).toContain('Release events · release-hook')
    expect(html).not.toContain('Billing events')
    expect(html).not.toContain('Legacy events')
    expect(html).not.toContain('data-testid="automation-rule-trigger-configuration"')
    expect(html).toContain('Only active endpoints can be selected by a rule.')
  })

  test('disables Webhook rule creation when no active endpoint is available', () => {
    const html = renderToStaticMarkup(
      <AutomationRuleEditor
        initialTriggerType="webhook"
        locale="en"
        webhookEndpoints={[pausedInboundWebhookEndpointFixture]}
        onCreate={async () => undefined}
      />,
    )

    expect(html).toContain('No active webhook endpoint is available.')
    expect(html).toContain('data-testid="automation-rule-webhook-endpoint" disabled=""')
    expect(html).toContain('data-testid="automation-rule-create" disabled=""')
  })

  test('only emits explicit conditions and requires real type-specific configuration', () => {
    expect(createAutomationConditions('', 'equals', '')).toEqual([])
    expect(createAutomationConditions(' workItem.workflowStatusId ', 'equals', ' done ')).toEqual([{
      field: 'workItem.workflowStatusId',
      operator: 'equals',
      type: 'field',
      value: 'done',
    }])
    expect(createAutomationConditions('event.comment', 'exists', '')).toEqual([{
      field: 'event.comment',
      operator: 'exists',
      type: 'field',
    }])

    for (const triggerType of ['custom-field', 'form', 'webhook'] as const) {
      expect(isAutomationTriggerConfigurationValid(triggerType, '')).toBe(false)
    }
    expect(isAutomationTriggerConfigurationValid('status', '')).toBe(true)
    expect(isAutomationTriggerConfigurationValid('due', 'unsupported')).toBe(false)

    for (const actionType of [
      'approval',
      'assign',
      'comment',
      'create',
      'move',
      'notify',
      'update',
      'webhook',
    ] as const) {
      expect(isAutomationActionConfigurationValid(actionType, '')).toBe(false)
    }
    expect(isAutomationActionConfigurationValid('webhook', 'http://example.com/hook')).toBe(false)
    expect(isAutomationActionConfigurationValid('webhook', 'https://example.com/hook')).toBe(true)
  })

  test('builds a DST-aware schedule trigger and rejects invalid schedule input', () => {
    expect(createAutomationScheduleTrigger({
      catchUpPolicy: 'latest',
      dayOfWeek: 2,
      frequency: 'weekly',
      localTime: '09:00',
      startDate: '2026-03-01',
      timeZone: ' America/New_York ',
    })).toEqual({
      type: 'schedule',
      schedule: {
        catchUpPolicy: 'latest',
        daysOfWeek: [2],
        frequency: 'weekly',
        interval: 1,
        localTime: '09:00',
        startDate: '2026-03-01',
        timeZone: 'America/New_York',
      },
    })
    expect(isAutomationScheduleConfigurationValid('America/New_York', '09:00')).toBe(true)
    expect(isAutomationScheduleConfigurationValid('Invalid/Time_Zone', '09:00')).toBe(false)
    expect(isAutomationScheduleConfigurationValid('America/New_York', '')).toBe(false)
    expect(isAutomationScheduleConfigurationValid('America/New_York', '24:00')).toBe(false)
  })

  test('renders schedule-specific fields and an inline error for invalid values', () => {
    const validHtml = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'all',
          daysOfWeek: [0],
          frequency: 'weekly',
          interval: 1,
          localTime: '09:00',
          startDate: '2026-03-01',
          timeZone: 'America/New_York',
        }}
        locale="en"
        onCreate={async () => undefined}
      />,
    )
    const invalidHtml = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'latest',
          frequency: 'daily',
          interval: 1,
          localTime: '',
          startDate: '2026-03-01',
          timeZone: 'Invalid/Time_Zone',
        }}
        locale="en"
        onCreate={async () => undefined}
      />,
    )

    expect(validHtml).toContain('Schedule configuration')
    expect(validHtml).toContain('data-testid="automation-rule-schedule-time-zone"')
    expect(validHtml).toContain('value="America/New_York"')
    expect(validHtml).toContain('data-testid="automation-rule-schedule-frequency"')
    expect(validHtml).toContain('data-testid="automation-rule-schedule-weekday"')
    expect(validHtml).toContain('Sunday')
    expect(validHtml).not.toContain('data-testid="automation-rule-trigger-configuration"')
    expect(invalidHtml).toContain('data-testid="automation-rule-schedule-error"')
    expect(invalidHtml).toContain('Enter a valid IANA time zone and local time.')
  })

  test('renders and validates the monthly day-of-month schedule field', () => {
    const validHtml = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'latest',
          dayOfMonth: 31,
          frequency: 'monthly',
          interval: 1,
          localTime: '09:00',
          startDate: '2026-03-01',
          timeZone: 'America/New_York',
        }}
        locale="en"
        onCreate={async () => undefined}
      />,
    )
    const invalidHtml = renderToStaticMarkup(
      <AutomationRuleEditor
        initialSchedule={{
          catchUpPolicy: 'latest',
          dayOfMonth: 32,
          frequency: 'monthly',
          interval: 1,
          localTime: '09:00',
          startDate: '2026-03-01',
          timeZone: 'America/New_York',
        }}
        locale="en"
        onCreate={async () => undefined}
      />,
    )

    expect(validHtml).toContain('data-testid="automation-rule-schedule-day-of-month"')
    expect(validHtml).toContain('value="31"')
    expect(invalidHtml).toContain('data-testid="automation-rule-schedule-cadence-error"')
    expect(invalidHtml).toContain('Enter a day of month from 1 through 31.')
  })

  test('creates template input from an AutomationValue-compatible JSON object', async () => {
    const parsed = parseAutomationTemplatePayload(`{
      "title": "Weekly review",
      "priority": "medium",
      "description": "Review open work every week",
      "customFieldValues": { "labels": ["weekly", "review"], "estimate": 3 }
    }`)
    expect(parsed).toHaveProperty('payload')
    if (!('payload' in parsed)) throw new Error('Expected a valid template payload.')
    const input = createAutomationTemplateEditorInput(' Weekly template ', 'work-item', parsed.payload)
    let submitted: unknown
    let resetCalls = 0

    expect(await submitAutomationEditorCreate(
      () => {
        submitted = input
      },
      () => {
        resetCalls += 1
      },
    )).toBe(true)
    expect(submitted).toEqual({
      enabled: true,
      kind: 'work-item',
      name: 'Weekly template',
      payload: {
        customFieldValues: { estimate: 3, labels: ['weekly', 'review'] },
        description: 'Review open work every week',
        priority: 'medium',
        title: 'Weekly review',
      },
    })
    expect(resetCalls).toBe(1)
  })

  test('rejects invalid template JSON and non-object payloads', () => {
    expect(parseAutomationTemplatePayload('{')).toEqual({ error: 'invalid-json' })
    expect(parseAutomationTemplatePayload('[]')).toEqual({ error: 'object-required' })
    expect(parseAutomationTemplatePayload('null')).toEqual({ error: 'object-required' })
    expect(parseAutomationTemplatePayload('{"description":"Missing title"}')).toEqual({
      error: 'invalid-value',
    })
    expect(parseAutomationTemplatePayload('{"title":"Review","metadata":{}}')).toEqual({
      error: 'invalid-value',
    })
    expect(parseAutomationTemplatePayload('{"estimate": 1e400}')).toEqual({ error: 'invalid-value' })
  })

  test('validates typed Project and Workflow template payloads', () => {
    expect(isAutomationProjectTemplatePayloadValid({ tone: 'blue' })).toBe(false)
    expect(isAutomationProjectTemplatePayloadValid({ nameJa: 'ローンチ準備', tone: 'purple' })).toBe(true)

    const workflow = createDefaultAutomationWorkflowTemplatePayload()
    expect(isAutomationWorkflowTemplatePayloadValid(workflow)).toBe(true)
    expect(isAutomationWorkflowTemplatePayloadValid({
      ...workflow,
      initialStatusId: 'missing',
    })).toBe(false)
  })

  test('retains template editor values when creation fails', async () => {
    const failure = new Error('Create failed')
    let name = 'Weekly template'
    let payloadJson = '{"title":"Weekly review"}'

    expect(await submitAutomationEditorCreate(
      async () => {
        throw failure
      },
      () => {
        name = ''
        payloadJson = '{}'
      },
    )).toBe(false)
    expect(name).toBe('Weekly template')
    expect(payloadJson).toBe('{"title":"Weekly review"}')
  })

  test('renders the common template payload JSON editor', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        initialTab="templates"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
        onCreateTemplate={async () => undefined}
      />,
    )

    expect(html).toContain('Payload (JSON)')
    expect(html).toContain('data-testid="automation-template-payload"')
    expect(html).toContain('The payload contains an unsupported JSON value or field name.')
  })

  test('renders typed Project and Workflow creation fields instead of JSON', () => {
    const projectHtml = renderToStaticMarkup(
      <AutomationTemplateEditor
        initialKind="project"
        locale="en"
        onCreate={async () => undefined}
      />,
    )
    const workflowHtml = renderToStaticMarkup(
      <AutomationTemplateEditor
        initialKind="workflow"
        locale="en"
        onCreate={async () => undefined}
      />,
    )

    expect(projectHtml).toContain('Project defaults')
    expect(projectHtml).toContain('data-testid="automation-template-project-name-ja"')
    expect(projectHtml).toContain('data-testid="automation-template-project-name-en"')
    expect(projectHtml).toContain('data-testid="automation-template-project-tone"')
    expect(projectHtml).not.toContain('data-testid="automation-template-payload"')
    expect(workflowHtml).toContain('data-testid="automation-template-workflow-editor"')
    expect(workflowHtml).toContain('data-testid="workflow-status-backlog"')
    expect(workflowHtml).toContain('Transition matrix')
    expect(workflowHtml).not.toContain('data-testid="automation-template-payload"')
  })

  test('keeps template kind immutable in the typed update editor', () => {
    const html = renderToStaticMarkup(
      <AutomationTemplateUpdateEditor
        locale="en"
        template={projectAutomationTemplateFixture}
        onCancel={() => undefined}
        onUpdate={async () => undefined}
      />,
    )

    expect(html).toContain('The template kind cannot be changed after creation.')
    expect(html).toContain('Project')
    expect(html).toContain('value="ローンチ準備"')
    expect(html).not.toContain('data-testid="automation-template-kind"')
    expect(html).not.toContain('data-testid="automation-template-payload"')
  })

  test('renders Project application receipt with its pinned immutable version', () => {
    const html = renderToStaticMarkup(
      <AutomationTemplateApplicationEditor
        initialApplication={projectTemplateApplicationFixture}
        locale="en"
        teams={teams}
        template={projectAutomationTemplateFixture}
        workflowTargets={[]}
        onApply={async () => projectTemplateApplicationFixture}
        onRefresh={async () => projectTemplateApplicationFixture}
      />,
    )

    expect(html).toContain('data-testid="automation-template-application-target"')
    expect(html).toContain('Core team')
    expect(html).toContain('Succeeded')
    expect(html).toContain('Pinned version 2')
    expect(html).toContain('application-project-launch')
    expect(html).toContain('Created project “ローンチ準備” (application-project-launch).')
  })

  test('renders Workflow workspace/team targets with expected revisions and result state', () => {
    const html = renderToStaticMarkup(
      <AutomationTemplateApplicationEditor
        initialApplication={workflowTemplateApplicationFixture}
        locale="en"
        teams={teams}
        template={workflowAutomationTemplateFixture}
        workflowTargets={[
          {
            expectedRevision: 7,
            name: 'Workspace',
            scopeId: 'workspace-demo',
            scopeType: 'workspace',
          },
          {
            expectedRevision: 0,
            inheritedFrom: 'workspace',
            name: 'Core team',
            scopeId: 'core-team',
            scopeType: 'team',
          },
        ]}
        onApply={async () => workflowTemplateApplicationFixture}
        onRefresh={async () => workflowTemplateApplicationFixture}
      />,
    )

    expect(html).toContain('Workspace default · revision 7')
    expect(html).toContain('Team: Core team · revision 0 · inherited (new override)')
    expect(html).toContain('Pinned version 3')
    expect(html).toContain('Saved the core-team workflow at revision 8.')
  })

  test('removes every mutation control in read-only mode', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        locale="en"
        readOnly
        recurringWork={[]}
        rules={[activeAutomationRuleFixture]}
        teams={teams}
        templates={[workItemAutomationTemplateFixture]}
        onCreateRule={async () => undefined}
        onToggleRule={async () => undefined}
      />,
    )

    expect(html).toContain('Read-only')
    expect(html).not.toContain('data-testid="automation-rule-create"')
    expect(html).not.toContain('data-testid="automation-rule-toggle-')
  })

  test('hides admin-only Webhook metadata and tab from non-managers', async () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        canViewWebhooks={false}
        executions={[]}
        initialTab="webhooks"
        locale="en"
        readOnly
        recurringWork={[]}
        rules={[activeAutomationRuleFixture]}
        teams={teams}
        templates={[]}
        webhooks={[activeInboundWebhookEndpointFixture]}
      />,
    )

    expect(html).not.toContain('data-testid="automation-tab-webhooks"')
    expect(html).not.toContain('data-testid="automation-inbound-webhooks-panel"')
    expect(html).not.toContain(activeInboundWebhookEndpointFixture.endpointUrl)
    expect(html).toContain('id="automation-panel-rules"')

    const originalFetch = globalThis.fetch
    const requestedUrls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      requestedUrls.push(url)
      const body = url.endsWith('/work-item-configuration')
        ? { configuration: { revision: 1, scopeId: 'workspace-demo' } }
        : {}
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }) as typeof fetch

    try {
      const memberData = await loadAutomationManagementData('member-token', [], false)
      expect(memberData.webhooks).toEqual([])
      expect(requestedUrls).not.toContain('/api/automation/inbound-webhooks')

      requestedUrls.length = 0
      await loadAutomationManagementData('admin-token', [], true)
      expect(requestedUrls).toContain('/api/automation/inbound-webhooks')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('renders inbound Webhook URLs and status-specific lifecycle controls', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        initialTab="webhooks"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
        webhooks={[
          activeInboundWebhookEndpointFixture,
          pausedInboundWebhookEndpointFixture,
          revokedInboundWebhookEndpointFixture,
        ]}
        onCreateWebhook={async () => inboundWebhookSecretResponseFixture}
        onPauseWebhook={async () => undefined}
        onResumeWebhook={async () => undefined}
        onRevokeWebhook={async () => undefined}
        onRotateWebhook={async () => inboundWebhookSecretResponseFixture}
      />,
    )

    expect(html).toContain('data-testid="automation-tab-webhooks"')
    expect(html).toContain('data-testid="automation-inbound-webhooks-panel"')
    expect(html).toContain('data-testid="automation-webhook-create"')
    expect(html).toContain(activeInboundWebhookEndpointFixture.endpointUrl)
    expect(html).toContain('data-testid="automation-webhook-pause-release-hook"')
    expect(html).toContain('data-testid="automation-webhook-resume-billing-hook"')
    expect(html).toContain('data-testid="automation-webhook-rotate-release-hook"')
    expect(html).toContain('data-testid="automation-webhook-rotate-billing-hook"')
    expect(html).not.toContain('data-testid="automation-webhook-rotate-legacy-hook"')
    expect(html).not.toContain('data-testid="automation-webhook-revoke-legacy-hook"')
  })

  test('keeps create and rotate secrets one-time and redacts durable endpoint markup', () => {
    const created = reduceAutomationWebhookSecret(undefined, {
      readOnly: false,
      response: inboundWebhookSecretResponseFixture,
      type: 'reveal',
    })
    const rotated = reduceAutomationWebhookSecret(created, {
      readOnly: false,
      response: {
        endpoint: {
          ...activeInboundWebhookEndpointFixture,
          secretGeneration: 3,
        },
        signingSecret: 'whsec_rotated_one_time_only',
      },
      type: 'reveal',
    })

    expect(created?.signingSecret).toBe('whsec_storybook_one_time_only')
    expect(rotated?.signingSecret).toBe('whsec_rotated_one_time_only')
    expect(reduceAutomationWebhookSecret(rotated, { type: 'dismiss' })).toBeUndefined()
    expect(reduceAutomationWebhookSecret(rotated, {
      endpointId: activeInboundWebhookEndpointFixture.id,
      type: 'revoke',
    })).toBeUndefined()

    const noticeHtml = renderToStaticMarkup(
      <AutomationWebhookSecretNotice
        endpointName={activeInboundWebhookEndpointFixture.name}
        locale="en"
        signingSecret={rotated?.signingSecret ?? ''}
        onDismiss={() => undefined}
      />,
    )
    const durableHtml = renderToStaticMarkup(
      <AutomationInboundWebhooksPanel
        endpoints={[activeInboundWebhookEndpointFixture]}
        locale="en"
        readOnly
      />,
    )

    expect(noticeHtml).toContain('whsec_rotated_one_time_only')
    expect(noticeHtml).toContain('This secret is shown only now.')
    expect(noticeHtml).toContain('data-testid="automation-webhook-secret-dismiss"')
    expect(durableHtml).not.toContain('whsec_')
    expect(durableHtml).not.toContain('automation-webhook-one-time-secret')
  })

  test('discards a one-time Webhook secret when access becomes read-only', () => {
    const revealed = reduceAutomationWebhookSecret(undefined, {
      readOnly: false,
      response: inboundWebhookSecretResponseFixture,
      type: 'reveal',
    })

    expect(reduceAutomationWebhookSecret(revealed, {
      readOnly: false,
      type: 'access-change',
    })).toEqual(revealed)
    expect(reduceAutomationWebhookSecret(revealed, {
      readOnly: true,
      type: 'access-change',
    })).toBeUndefined()
    expect(reduceAutomationWebhookSecret(revealed, {
      readOnly: true,
      response: inboundWebhookSecretResponseFixture,
      type: 'reveal',
    })).toBeUndefined()
  })

  test('disables every Webhook mutation while one endpoint mutation is pending', () => {
    const html = renderToStaticMarkup(
      <AutomationInboundWebhooksPanel
        busyOperation={`webhook:rotate:${activeInboundWebhookEndpointFixture.id}`}
        endpoints={[
          activeInboundWebhookEndpointFixture,
          pausedInboundWebhookEndpointFixture,
        ]}
        locale="en"
        readOnly={false}
        onCreate={async () => inboundWebhookSecretResponseFixture}
        onPause={async () => undefined}
        onResume={async () => undefined}
        onRevoke={async () => undefined}
        onRotate={async () => inboundWebhookSecretResponseFixture}
      />,
    )

    for (const testId of [
      'automation-webhook-create',
      `automation-webhook-pause-${activeInboundWebhookEndpointFixture.id}`,
      `automation-webhook-rotate-${activeInboundWebhookEndpointFixture.id}`,
      `automation-webhook-revoke-${activeInboundWebhookEndpointFixture.id}`,
      `automation-webhook-resume-${pausedInboundWebhookEndpointFixture.id}`,
      `automation-webhook-rotate-${pausedInboundWebhookEndpointFixture.id}`,
      `automation-webhook-revoke-${pausedInboundWebhookEndpointFixture.id}`,
    ]) {
      expect(html).toMatch(new RegExp(
        `<button[^>]*data-testid="${testId}"[^>]*disabled=""`,
      ))
    }
  })

  test('warns administrators how to abort a provisioning Webhook in English and Japanese', () => {
    const englishHtml = renderToStaticMarkup(
      <AutomationInboundWebhooksPanel
        endpoints={[provisioningInboundWebhookEndpointFixture]}
        locale="en"
        readOnly={false}
        onRevoke={async () => undefined}
      />,
    )
    const japaneseHtml = renderToStaticMarkup(
      <AutomationInboundWebhooksPanel
        endpoints={[provisioningInboundWebhookEndpointFixture]}
        locale="ja"
        readOnly
        onRevoke={async () => undefined}
      />,
    )

    expect(englishHtml).toContain(
      'data-testid="automation-webhook-provisioning-warning-rotating-hook"',
    )
    expect(englishHtml).toContain('Webhook deliveries are unavailable while provisioning')
    expect(englishHtml).toContain('public endpoint returns 404')
    expect(englishHtml).toContain('An administrator can revoke it to abort provisioning')
    expect(englishHtml).toContain('reconfigure every rule and sender to use a new endpoint')
    expect(englishHtml).toContain('data-testid="automation-webhook-revoke-rotating-hook"')
    expect(englishHtml).not.toContain('data-testid="automation-webhook-rotate-rotating-hook"')
    expect(japaneseHtml).toContain('管理者は失効して処理を中止できます')
    expect(japaneseHtml).toContain('準備中は Webhook delivery を受信できず')
    expect(japaneseHtml).toContain('public endpoint は 404 を返します')
    expect(japaneseHtml).toContain('Rule と送信元を新しい endpoint へ再設定してください')
    expect(japaneseHtml).toContain(
      'data-testid="automation-webhook-provisioning-warning-rotating-hook"',
    )
  })

  test('hides inbound Webhook lifecycle controls in read-only mode', () => {
    const html = renderToStaticMarkup(
      <AutomationInboundWebhooksPanel
        endpoints={[activeInboundWebhookEndpointFixture]}
        locale="en"
        readOnly
        onCreate={async () => inboundWebhookSecretResponseFixture}
        onPause={async () => undefined}
        onRevoke={async () => undefined}
        onRotate={async () => inboundWebhookSecretResponseFixture}
      />,
    )

    expect(html).toContain(activeInboundWebhookEndpointFixture.endpointUrl)
    expect(html).not.toContain('data-testid="automation-webhook-create"')
    expect(html).not.toContain('data-testid="automation-webhook-pause-')
    expect(html).not.toContain('data-testid="automation-webhook-rotate-')
    expect(html).not.toContain('data-testid="automation-webhook-revoke-')
  })

  test('renders DST-aware recurring schedule and dead-letter action failures', () => {
    const recurringHtml = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        initialTab="recurring"
        locale="en"
        recurringWork={[dstRecurringWorkFixture]}
        rules={[]}
        teams={teams}
        templates={[workItemAutomationTemplateFixture]}
      />,
    )
    const executionHtml = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[deadLetterAutomationExecutionFixture]}
        initialTab="runs"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
        onRetryExecution={async () => undefined}
      />,
    )

    expect(recurringHtml).toContain('America/New_York')
    expect(recurringHtml).toContain('Next run')
    expect(recurringHtml).toContain('Mar 8, 2026 at 9:00 AM')
    expect(executionHtml).toContain('Dead letter')
    expect(executionHtml).toContain('The execution reached the retry limit')
    expect(executionHtml).toContain('rule outbound webhook:v2:0')
    expect(executionHtml).toContain('Retry')
    expect(executionHtml).toContain('data-testid="automation-run-retry-execution-dead-letter-1"')
  })

  test('offers only enabled Work Item templates for recurring work', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[]}
        initialTab="recurring"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[
          workItemAutomationTemplateFixture,
          { ...workItemAutomationTemplateFixture, enabled: false, id: 'disabled', name: 'Disabled template' },
          { ...workItemAutomationTemplateFixture, id: 'project', kind: 'project', name: 'Project template' },
        ]}
        onCreateRecurringWork={async () => undefined}
      />,
    )

    expect(html).toContain(workItemAutomationTemplateFixture.name)
    expect(html).not.toContain('Disabled template')
    expect(html).not.toContain('Project template')
  })

  test('does not offer retry when a dead-letter execution is not retryable', () => {
    const html = renderToStaticMarkup(
      <AutomationManagementPanel
        executions={[{ ...deadLetterAutomationExecutionFixture, retryable: false }]}
        initialTab="runs"
        locale="en"
        recurringWork={[]}
        rules={[]}
        teams={teams}
        templates={[]}
        onRetryExecution={async () => undefined}
      />,
    )

    expect(html).toContain('Dead letter')
    expect(html).not.toContain('data-testid="automation-run-retry-')
  })
})
