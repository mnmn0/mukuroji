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

  test('keeps spaces in saved text values and allows as many entries as the server', () => {
    const saved: AutomationRule = {
      ...rule,
      conditions: [{ field: 'workItem.title', operator: 'contains', value: 'Urgent ' }],
      actions: Array.from({ length: 25 }, (_value, index) => ({ type: 'comment' as const, body: `Step ${index}` })),
    }
    const draft = { ...createAutomationRuleDraft(saved), name: 'Renamed' }

    expect(isAutomationRuleDraftValid(draft)).toBe(true)
    expect(createAutomationRuleDraftUpdate(saved, draft)).toEqual({
      expectedRevision: saved.revision,
      name: 'Renamed',
      conditions: saved.conditions,
    })
  })

  test('keeps a saved empty-text comparison so unrelated edits still save', () => {
    const saved: AutomationRule = {
      ...rule,
      conditions: [{ field: 'workItem.description', operator: 'equals', value: '' }],
    }
    const draft = { ...createAutomationRuleDraft(saved), name: 'Renamed' }

    expect(draft.savedConditions).toEqual(saved.conditions)
    expect(isAutomationRuleDraftValid(draft)).toBe(true)
    expect(createAutomationRuleDraftUpdate(saved, draft)).toEqual({
      expectedRevision: saved.revision,
      name: 'Renamed',
      conditions: saved.conditions,
    })
  })

  test('leaves untouched actions with surrounding spaces out of a name-only edit', () => {
    const saved: AutomationRule = {
      ...rule,
      actions: [
        { type: 'update', patch: { title: '  Padded title ' } },
        { type: 'create', templateId: 'template-1', templateVersion: 2 },
      ],
    }
    const draft = { ...createAutomationRuleDraft(saved), name: 'Renamed' }

    expect(createAutomationRuleDraftUpdate(saved, draft).actions).toBeUndefined()
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

  test('saves number and boolean custom field values with their type', () => {
    const typed: AutomationRule = {
      ...rule,
      conditions: [
        { type: 'field', field: 'workItem.customFieldValues.estimate', operator: 'greater-than', value: 3 },
        { type: 'field', field: 'workItem.customFieldValues.billable', operator: 'equals', value: true },
      ],
    }
    const draft = createAutomationRuleDraft(typed)

    expect(draft.conditions.map((condition) => condition.valueType)).toEqual(['number', 'boolean'])
    expect(createAutomationRuleDraftUpdate(typed, draft).conditions).toEqual(typed.conditions)
    const notANumber = { ...draft, conditions: [{ ...draft.conditions[0]!, value: 'three' }] }
    expect(isAutomationRuleDraftValid(notANumber)).toBe(false)
  })

  test('keeps a saved create action with values and a pinned version out of a name-only edit', () => {
    const pinned: AutomationRule = {
      ...rule,
      actions: [{ type: 'create', templateId: 'template-1', templateVersion: 3, values: { title: 'Follow up' } }],
    }
    const draft = { ...createAutomationRuleDraft(pinned), name: 'Renamed' }

    expect(createAutomationRuleDraftUpdate(pinned, draft).actions).toBeUndefined()
  })

  test('keeps the assignee flag of a notify action through an edit', () => {
    const assigneeRule: AutomationRule = {
      ...rule,
      actions: [{ type: 'notify', recipientMemberKeys: [], notifyAssignee: true, title: 'Due soon' }],
    }
    const draft = createAutomationRuleDraft(assigneeRule)
    expect(isAutomationRuleDraftValid(draft)).toBe(true)
    const update = createAutomationRuleDraftUpdate(assigneeRule, { ...draft, name: 'Renamed' })
    expect(update.actions).toBeUndefined()
    const action = draft.actions[0]
    if (action?.type !== 'notify') throw new Error('Expected a notify draft.')
    const changed = createAutomationRuleDraftUpdate(assigneeRule, {
      ...draft,
      actions: [{ ...action, title: 'Due in 3 days' }],
    })
    expect(changed.actions).toEqual([
      { type: 'notify', recipientMemberKeys: [], notifyAssignee: true, title: 'Due in 3 days' },
    ])
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
    expect(readOnlyMarkup).not.toContain(`automation-rule-edit-${rule.id}`)
  })
})
