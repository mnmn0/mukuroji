import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { AutomationRule } from '@mukuroji/contracts'
import { activeAutomationRuleFixture } from '../src/automation/fixtures'
import {
  createAutomationRuleDraft,
  createAutomationRuleDraftUpdate,
  createEmptyAutomationRuleActionDraft,
  isAutomationRuleActionDraftValid,
  isAutomationRuleDraftValid,
  moveAutomationRuleDraftItem,
} from '../src/automation/model/ruleDefinitionDraft'
import { AutomationRuleDefinitionEditor } from '../src/automation/ui/AutomationRuleDefinitionEditor'
import { AutomationManagementPanel } from '../src/automation/ui/AutomationManagementPanel'

const rule: AutomationRule = activeAutomationRuleFixture

describe('automation rule definition draft', () => {
  test('round-trips top-level conditions and actions into an update', () => {
    const draft = createAutomationRuleDraft(rule)

    expect(draft.match).toBe('all')
    expect(draft.conditions).toEqual([{ field: 'workItem.priority', operator: 'equals', value: 'high' }])
    expect(createAutomationRuleDraftUpdate(rule, draft)).toEqual({
      expectedRevision: rule.revision,
      name: rule.name,
      conditions: rule.conditions,
    })
    const edited = { ...draft, actions: [...draft.actions, createEmptyAutomationRuleActionDraft('webhook', rule.name)] }
    expect(createAutomationRuleDraftUpdate(rule, edited).actions).toEqual([
      ...rule.actions,
      { type: 'webhook', url: '' },
    ])
  })

  test('leaves unchanged create actions out so their pinned template version stays', () => {
    const pinned: AutomationRule = {
      ...rule,
      actions: [{ type: 'create', templateId: 'template-1', templateVersion: 3 }],
    }
    const draft = createAutomationRuleDraft(pinned)

    expect(createAutomationRuleDraftUpdate(pinned, draft).actions).toBeUndefined()
    expect(createAutomationRuleDraftUpdate(pinned, {
      ...draft,
      actions: [{ type: 'create', templateId: 'template-2' }],
    }).actions).toEqual([{ type: 'create', templateId: 'template-2' }])
  })

  test('saves rows matched by any condition as one any group', () => {
    const draft = {
      ...createAutomationRuleDraft(rule),
      match: 'any' as const,
      conditions: [
        { field: 'workItem.priority', operator: 'equals' as const, value: 'high' },
        { field: 'workItem.assigneeUserId', operator: 'not-exists' as const, value: 'ignored' },
      ],
    }

    expect(createAutomationRuleDraftUpdate(rule, draft).conditions).toEqual([{
      type: 'any',
      conditions: [
        { type: 'field', field: 'workItem.priority', operator: 'equals', value: 'high' },
        { type: 'field', field: 'workItem.assigneeUserId', operator: 'not-exists' },
      ],
    }])
  })

  test('keeps nested conditions it cannot show as rows unchanged', () => {
    const nested: AutomationRule = {
      ...rule,
      conditions: [{
        type: 'not',
        condition: { type: 'field', field: 'workItem.priority', operator: 'equals', value: 'low' },
      }],
    }
    const draft = createAutomationRuleDraft(nested)

    expect(draft.savedConditions).toEqual(nested.conditions)
    expect(createAutomationRuleDraftUpdate(nested, draft).conditions).toEqual(nested.conditions)
  })

  test('reorders actions and rejects incomplete ones', () => {
    const notify = createEmptyAutomationRuleActionDraft('notify', 'Due soon')
    const webhook = createEmptyAutomationRuleActionDraft('webhook', 'Due soon')

    expect(moveAutomationRuleDraftItem([notify, webhook], 1, -1)).toEqual([webhook, notify])
    expect(moveAutomationRuleDraftItem([notify, webhook], 0, -1)).toEqual([notify, webhook])
    expect(isAutomationRuleActionDraftValid(notify)).toBe(false)
    expect(isAutomationRuleActionDraftValid({ ...notify, type: 'notify', memberKeys: ['member-1'] })).toBe(true)
    expect(isAutomationRuleActionDraftValid({ type: 'webhook', url: 'http://example.com' })).toBe(false)
    expect(isAutomationRuleDraftValid({ ...createAutomationRuleDraft(rule), actions: [] })).toBe(false)
  })
})

describe('AutomationRuleDefinitionEditor', () => {
  test('renders conditions, ordered actions, and the dry run', () => {
    const markup = renderToStaticMarkup(createElement(AutomationRuleDefinitionEditor, {
      locale: 'ja',
      rule,
      options: { members: [], teams: [{ id: 'core', label: 'Core' }], projects: [], statuses: [], customFields: [], workItemTemplates: [] },
      onSave: () => undefined,
      onDryRun: () => Promise.resolve({ matched: true, triggerType: 'status', conditions: [], actions: [] }),
      onCancel: () => undefined,
    }))

    expect(markup).toContain('ルールを編集')
    expect(markup).toContain('すべての条件に一致')
    expect(markup).toContain('この Work Item で試す')
  })

  test('shows edit and delete controls only to administrators', () => {
    const props = {
      locale: 'ja' as const,
      rules: [rule],
      templates: [],
      recurringWork: [],
      executions: [],
      teams: [],
      onUpdateRule: () => undefined,
      onDeleteRule: () => undefined,
    }

    const adminMarkup = renderToStaticMarkup(createElement(AutomationManagementPanel, props))
    expect(adminMarkup).toContain(`automation-rule-edit-${rule.id}`)
    expect(adminMarkup).toContain(`automation-rule-delete-${rule.id}`)

    const readOnlyMarkup = renderToStaticMarkup(createElement(AutomationManagementPanel, { ...props, readOnly: true }))
    expect(readOnlyMarkup).not.toContain(`automation-rule-delete-${rule.id}`)
  })
})
