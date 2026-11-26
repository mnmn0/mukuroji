import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { workspaceWorkItemConfigurationFixture } from '../src/work-items/fixtures'
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
