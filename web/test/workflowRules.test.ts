import { afterEach, expect, test } from 'bun:test'
import { TeamIssuesApiError, updateTeamIssue } from '../src/issues/api'
import { describeWorkflowRuleRejection } from '../src/issues/model/workflowRuleErrors'
import { createTranslator } from '../src/shared/i18n/i18n'
import { workspaceWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import {
  pruneWorkflowStatusRequiredCustomFields,
  setWorkflowStatusRequiredCustomField,
  setWorkflowStatusRequiredField,
  setWorkflowTransitionActorRole,
} from '../src/work-items/model/workflowRules'

const originalFetch = globalThis.fetch
const workflow = workspaceWorkItemConfigurationFixture.workflow

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('keeps transition roles in display order and drops an empty list', () => {
  const assignee = setWorkflowTransitionActorRole(workflow, 'review', 'done', 'assignee', true)
  const both = setWorkflowTransitionActorRole(assignee, 'review', 'done', 'project-manager', true)
  expect(both.transitions.find((transition) => transition.toStatusId === 'done')?.allowedActorRoles)
    .toEqual(['project-manager', 'assignee'])
  const cleared = setWorkflowTransitionActorRole(
    setWorkflowTransitionActorRole(both, 'review', 'done', 'assignee', false),
    'review', 'done', 'project-manager', false,
  )
  expect(cleared.transitions.find((transition) => transition.toStatusId === 'done'))
    .toEqual({ fromStatusId: 'review', toStatusId: 'done' })
})

test('edits status required fields and prunes custom fields that are gone or became formulas', () => {
  const required = setWorkflowStatusRequiredCustomField(
    setWorkflowStatusRequiredField(workflow, 'done', 'due-date', true),
    'done', 'customer-impact', true,
  )
  expect(required.statuses.find((status) => status.id === 'done')).toMatchObject({
    requiredFields: ['due-date'],
    requiredCustomFieldIds: ['customer-impact'],
  })
  const pruned = pruneWorkflowStatusRequiredCustomFields({
    ...workspaceWorkItemConfigurationFixture,
    workflow: required,
    customFields: [],
  })
  expect(pruned.workflow.statuses.find((status) => status.id === 'done')).toEqual({
    id: 'done', name: 'Done', category: 'completed', sortOrder: 4, requiredFields: ['due-date'],
  })
})

test('carries workflow rule reasons from the Team API and explains them in the person’s language', async () => {
  globalThis.fetch = (async () => Response.json({
    code: 'WorkflowStatusRequirementsNotMet',
    message: 'Fields required in the target status are empty.',
    unmetConditions: [
      { rule: 'required-field', field: 'acceptance-criteria', message: 'x' },
      { rule: 'required-custom-field', customFieldId: 'customer-impact', message: 'x' },
      { rule: 'unknown', message: 'dropped' },
    ],
  }, { status: 409 })) as unknown as typeof fetch

  const error = await updateTeamIssue('core-team', 'task-1', 'token', { expectedRevision: 1, workflowStatusId: 'done' }, {
    correlationId: 'c', idempotencyKey: 'i',
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(TeamIssuesApiError)
  expect(describeWorkflowRuleRejection(error, createTranslator('ja'), new Map([['customer-impact', '顧客影響']])))
    .toBe('この状態に移すには次の項目を入力してください: 受け入れ条件、顧客影響')
  const denied = new TeamIssuesApiError(403, 'denied', 'WorkflowTransitionActorDenied', [
    { rule: 'transition-actor', allowedActorRoles: ['project-manager', 'assignee'], message: 'x' },
  ])
  expect(describeWorkflowRuleRejection(denied, createTranslator('en')))
    .toBe('Only Project manager or Assignee can make this status change, from the Web.')
  expect(describeWorkflowRuleRejection(new TeamIssuesApiError(409, 'conflict', 'WorkItemRevisionConflict'), createTranslator('en')))
    .toBeUndefined()
})
