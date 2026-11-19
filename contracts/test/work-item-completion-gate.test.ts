import { expect, test } from 'bun:test'
import {
  evaluateWorkItemCompletionGate,
  hasWorkItemCompletionGateConditions,
  needsWorkItemCompletionGateApprovals,
} from '../src/work-item-completion-gate'

const noApprovals = { pendingCount: 0, approvedCount: 0, changesRequestedCount: 0 }

test('evaluates nothing when the policy is absent or every condition is off', () => {
  expect(hasWorkItemCompletionGateConditions(undefined)).toBe(false)
  expect(hasWorkItemCompletionGateConditions({ acceptanceCriteria: 'off' })).toBe(false)
  expect(evaluateWorkItemCompletionGate(undefined, {
    acceptanceCriteria: [{ id: 'a', text: 'Open', satisfied: false }],
    approvalSummary: undefined,
  })).toEqual([])
})

test('reads approvals only for approval conditions', () => {
  expect(needsWorkItemCompletionGateApprovals({ acceptanceCriteria: 'required' })).toBe(false)
  expect(needsWorkItemCompletionGateApprovals({ noPendingApprovals: 'warn' })).toBe(true)
  expect(needsWorkItemCompletionGateApprovals({ humanApproval: 'required' })).toBe(true)
})

test('treats a Work Item without acceptance criteria as meeting the criteria condition', () => {
  expect(evaluateWorkItemCompletionGate({ acceptanceCriteria: 'required' }, {
    acceptanceCriteria: [],
    approvalSummary: undefined,
  })).toEqual([])
})

test('reports unmet conditions in display order with their requirement', () => {
  expect(evaluateWorkItemCompletionGate(
    { humanApproval: 'required', noPendingApprovals: 'warn', acceptanceCriteria: 'required' },
    {
      acceptanceCriteria: [{ id: 'a', text: 'Open', satisfied: false }, { id: 'b', text: 'Done', satisfied: true }],
      approvalSummary: { ...noApprovals, changesRequestedCount: 1 },
    },
  )).toEqual([
    { condition: 'acceptance-criteria', requirement: 'required', reason: 'unmet', message: '1 of 2 acceptance criteria are not satisfied.' },
    { condition: 'no-pending-approvals', requirement: 'warn', reason: 'unmet', message: '1 approval(s) are pending or have changes requested.' },
    { condition: 'human-approval', requirement: 'required', reason: 'unmet', message: 'No approval has been approved.' },
  ])
})

test('fails approval conditions closed when approvals are unavailable', () => {
  expect(evaluateWorkItemCompletionGate({ noPendingApprovals: 'required', humanApproval: 'required' }, {
    acceptanceCriteria: [],
    approvalSummary: undefined,
  }).map(({ condition, reason }) => ({ condition, reason }))).toEqual([
    { condition: 'no-pending-approvals', reason: 'unavailable' },
    { condition: 'human-approval', reason: 'unavailable' },
  ])
  expect(evaluateWorkItemCompletionGate({ noPendingApprovals: 'required', humanApproval: 'required' }, {
    acceptanceCriteria: [],
    approvalSummary: { ...noApprovals, approvedCount: 1 },
  })).toEqual([])
})
