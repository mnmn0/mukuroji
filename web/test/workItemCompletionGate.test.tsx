import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TeamIssuesApiError } from '../src/issues/api/errors'
import { describeWorkflowRuleRejection } from '../src/issues/model/workflowRuleErrors'
import { createTranslator } from '../src/shared/i18n/i18n'
import { workspaceWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { readCompletionGateOverrideSubmission } from '../src/work-items/model/completionGateOverride'
import { CompletionGateConfigurationSection } from '../src/work-items/ui/CompletionGateConfigurationSection'
import { WorkItemCompletionGateStatus } from '../src/work-items/ui/WorkItemCompletionGateStatus'

test('shows nothing when the Team evaluates no completion Gate condition', () => {
  expect(renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[{ id: 'a', text: 'Open', satisfied: false }]}
      approvalSummary={undefined}
      locale="en"
      policy={{ acceptanceCriteria: 'off' }}
    />,
  )).toBe('')
})

test('lists met and unmet conditions with their requirement', () => {
  const markup = renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[{ id: 'a', text: 'Done', satisfied: true }]}
      approvalSummary={undefined}
      locale="en"
      policy={{ acceptanceCriteria: 'required', humanApproval: 'warn' }}
    />,
  )

  expect(markup).toContain('1 of 2 met')
  expect(markup).toContain('data-state="met"')
  // No approval summary means the Work Item has no approvals, so the approval condition is unmet.
  expect(markup).toContain('data-state="unmet"')
  expect(markup).toContain('At least one approval is approved')
  expect(markup).toContain('Warn · Not met')
})

test('counts approvals from the Work Item summary', () => {
  const markup = renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[]}
      approvalSummary={{ pendingCount: 1, overdueCount: 0, approvedCount: 1, changesRequestedCount: 0 }}
      locale="en"
      policy={{ noPendingApprovals: 'required', humanApproval: 'required' }}
    />,
  )

  expect(markup).toContain('1 of 2 met')
  expect(markup).toContain('Required · Not met')
})

test('shows each saved Gate requirement in the configuration section', () => {
  const markup = renderToStaticMarkup(
    <CompletionGateConfigurationSection
      configuration={{ ...workspaceWorkItemConfigurationFixture, completionGate: { humanApproval: 'required' } }}
      locale="en"
      onChange={() => {}}
    />,
  )

  expect(markup).toContain('Completion Gate')
  expect(markup.match(/<option value="required" selected="">/g)?.length).toBe(1)
  expect(markup.match(/<option value="off" selected="">/g)?.length).toBe(2)
})

test('offers a manager the override reason only while a required condition is unmet', () => {
  const blocked = renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[{ id: 'a', text: 'Open', satisfied: false }]}
      approvalSummary={undefined}
      locale="en"
      overrideFormId="editor"
      policy={{ acceptanceCriteria: 'required' }}
    />,
  )
  expect(blocked).toContain('name="completionGateOverrideReason"')
  expect(blocked).toContain('form="editor"')
  expect(blocked).toContain('maxLength="1000"')

  const warnOnly = renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[{ id: 'a', text: 'Open', satisfied: false }]}
      approvalSummary={undefined}
      locale="en"
      overrideFormId="editor"
      policy={{ acceptanceCriteria: 'warn' }}
    />,
  )
  expect(warnOnly).not.toContain('completionGateOverrideReason')

  const member = renderToStaticMarkup(
    <WorkItemCompletionGateStatus
      acceptanceCriteria={[{ id: 'a', text: 'Open', satisfied: false }]}
      approvalSummary={undefined}
      locale="en"
      policy={{ acceptanceCriteria: 'required' }}
    />,
  )
  expect(member).not.toContain('completionGateOverrideReason')
})

test('reads a typed override reason from the editor form', () => {
  const formData = new FormData()
  expect(readCompletionGateOverrideSubmission(formData)).toBeUndefined()
  formData.set('completionGateOverrideReason', '   ')
  expect(readCompletionGateOverrideSubmission(formData)).toBeUndefined()
  formData.set('completionGateOverrideReason', '  Accepted in review  ')
  expect(readCompletionGateOverrideSubmission(formData)).toEqual({ reason: 'Accepted in review' })
})

test('explains a completion Gate rejection', () => {
  const t = createTranslator('en')
  const error = new TeamIssuesApiError(409, 'Gate', 'WorkItemCompletionGateNotSatisfied')
  expect(describeWorkflowRuleRejection(error, t)).toContain('completion Gate is not met')
  expect(describeWorkflowRuleRejection(new Error('wrapped', { cause: error }), t)).toContain('completion Gate is not met')
  expect(describeWorkflowRuleRejection(new TeamIssuesApiError(409, 'Other', 'WorkItemRevisionConflict'), t)).toBeUndefined()
})
