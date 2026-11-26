import { describe, expect, test } from 'bun:test'
import { parseDecideProjectExpenseRequest, parseProjectExpense, parseProjectExpenseInput } from '../src/project-expenses'

describe('parseProjectExpenseInput', () => {
  test('normalizes text, drops repeated receipts, and leaves out empty optional fields', () => {
    expect(parseProjectExpenseInput({
      date: '2026-11-19',
      category: ' 外注費 ',
      amountMinor: 120_000,
      currency: 'JPY',
      description: '  ',
      workItemId: '',
      receiptFileIds: ['file-1', ' file-1 ', 'file-2'],
    })).toEqual({
      ok: true,
      value: { date: '2026-11-19', category: '外注費', amountMinor: 120_000, currency: 'JPY', receiptFileIds: ['file-1', 'file-2'] },
    })
  })

  test.each([
    ['a date that does not exist', { date: '2026-02-30' }],
    ['an empty category', { category: ' ' }],
    ['a zero amount', { amountMinor: 0 }],
    ['a fractional amount', { amountMinor: 10.5 }],
    ['a lower-case currency', { currency: 'jpy' }],
    ['too many receipts', { receiptFileIds: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['a control character', { description: 'a\u0007b' }],
  ])('refuses %s', (_name, override) => {
    const result = parseProjectExpenseInput({ date: '2026-11-19', category: '外注費', amountMinor: 1, currency: 'JPY', ...override })
    expect(result.ok).toBe(false)
  })
})

describe('parseProjectExpense', () => {
  const stored = {
    id: 'x1',
    teamId: 't',
    projectId: 'p',
    date: '2026-11-19',
    category: '外注費',
    amountMinor: 1_000,
    currency: 'JPY',
    receiptFileIds: [],
    status: 'approved',
    submittedByMemberId: 'a@example.com',
    submittedAt: '2026-11-19T00:00:00.000Z',
    decision: { outcome: 'approved', decidedByMemberId: 'b@example.com', decidedAt: '2026-11-19T01:00:00.000Z' },
    revision: 2,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T01:00:00.000Z',
  }

  test('accepts a decided expense whose status matches its decision', () => {
    expect(parseProjectExpense(stored)?.status).toBe('approved')
  })

  test('refuses a status without a matching decision', () => {
    expect(parseProjectExpense({ ...stored, status: 'rejected' })).toBeUndefined()
    expect(parseProjectExpense({ ...stored, status: 'submitted' })).toBeUndefined()
    const { decision: _decision, ...undecided } = stored
    expect(parseProjectExpense(undecided)).toBeUndefined()
  })
})

test('parseDecideProjectExpenseRequest requires an outcome and a revision', () => {
  expect(parseDecideProjectExpenseRequest({ outcome: 'rejected', note: ' 証憑なし ', expectedRevision: 1 }))
    .toEqual({ ok: true, value: { outcome: 'rejected', note: '証憑なし', expectedRevision: 1 } })
  expect(parseDecideProjectExpenseRequest({ outcome: 'approved' }).ok).toBe(false)
  expect(parseDecideProjectExpenseRequest({ outcome: 'held', expectedRevision: 1 }).ok).toBe(false)
})
