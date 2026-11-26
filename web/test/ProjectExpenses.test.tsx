import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectExpense } from '@mukuroji/contracts'
import { createProjectExpense, readProjectExpenseList } from '../src/features/time-tracking/api/projectExpenses'
import { createProjectExpenseSubmitter } from '../src/features/time-tracking/mutations/useProjectExpenseMutations'
import { projectBudgetReportFixture } from '../src/features/time-tracking/reportFixtures'
import { ProjectBudgetReportPanel } from '../src/features/time-tracking/ui/ProjectBudgetReportPanel'
import { ProjectExpensesPanel } from '../src/features/time-tracking/ui/ProjectExpensesPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** An expense another manager submitted. */
const submitted: ProjectExpense = {
  id: 'x1',
  teamId: 'core-team',
  projectId: 'atlas',
  date: '2026-11-19',
  category: '外注費',
  amountMinor: 120_000,
  currency: 'JPY',
  receiptFileIds: ['file-1'],
  status: 'submitted',
  submittedByMemberId: 'other@example.com',
  submittedAt: '2026-11-19T00:00:00.000Z',
  revision: 1,
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
}

/**
 * Renders the panel with no-op actions.
 *
 * @param expenses - Expenses to show.
 * @param viewerMemberId - Viewer member key.
 * @returns Static markup.
 */
function render(expenses: ProjectExpense[], viewerMemberId: string) {
  return renderToStaticMarkup(
    <ProjectExpensesPanel
      defaultCurrency="JPY"
      expenses={expenses}
      locale="ja"
      onDecide={async () => undefined}
      onDelete={async () => undefined}
      onRetry={() => undefined}
      onSubmit={async () => undefined}
      t={createTranslator('ja')}
      today="2026-11-26"
      viewerMemberId={viewerMemberId}
    />,
  )
}

describe('Project expenses', () => {
  test('reads a valid list and rejects one with a malformed expense', () => {
    const list = { teamId: 'core-team', projectId: 'atlas', viewerMemberId: 'me@example.com', expenses: [submitted] }
    expect(readProjectExpenseList(JSON.parse(JSON.stringify(list)))).toEqual(list)
    expect(readProjectExpenseList({ ...list, expenses: [{ ...submitted, amountMinor: -1 }] })).toBeUndefined()
  })

  test('offers approval only to a manager other than the submitter', () => {
    const forOther = render([submitted], 'me@example.com')
    expect(forOther).toContain('承認')
    expect(forOther).toContain('証憑 1 件')
    const forSubmitter = render([submitted], 'other@example.com')
    expect(forSubmitter).toContain('ほかの Project マネージャーの承認待ち')
    expect(forSubmitter).not.toContain('>承認<')
  })

  test('keeps an approved expense without a delete button', () => {
    const approved = render([{ ...submitted, status: 'approved', revision: 2, decision: { outcome: 'approved', decidedByMemberId: 'me@example.com', decidedAt: '2026-11-19T01:00:00.000Z' } }], 'me@example.com')
    expect(approved).not.toContain('>削除<')
  })

  test('sends the expense with an idempotency key', async () => {
    let headers: Headers | undefined
    let body: unknown
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      body = JSON.parse(String(init?.body))
      return Response.json({ expense: submitted }, { status: 201 })
    }, { preconnect: originalFetch.preconnect })

    const stored = await createProjectExpense('token', 'core-team', 'atlas', {
      date: '2026-11-19',
      category: '外注費',
      amountMinor: 120_000,
      currency: 'JPY',
      receiptFileIds: ['file-1'],
    }, { idempotencyKey: 'key-1', correlationId: 'key-1' })

    expect(stored.id).toBe('x1')
    expect(headers?.get('Idempotency-Key')).toBe('key-1')
    expect(body).toMatchObject({ amountMinor: 120_000, receiptFileIds: ['file-1'] })
  })

  test('retries an unanswered submission with the same key and the receipt already uploaded', async () => {
    const calls: string[] = []
    const expenseKeys: (string | null)[] = []
    let failExpense = true
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.replace(/^.*\/projects\/atlas/u, '')}`)
      if (url.startsWith('https://upload.example/')) return new Response(null, { status: 200 })
      if (url.endsWith('/expenses')) {
        expenseKeys.push(new Headers(init?.headers).get('Idempotency-Key'))
        if (failExpense) throw new TypeError('network')
        return Response.json({ expense: submitted }, { status: 201 })
      }
      if (url.endsWith('/complete')) return Response.json({ file: { id: 'file-1' }, version: { id: 'v1' } })
      return Response.json({
        file: { id: 'file-1' },
        version: { id: 'v1' },
        upload: { url: 'https://upload.example/receipt', method: 'PUT', headers: {}, maxSizeBytes: 1_000 },
      }, { status: 201 })
    }, { preconnect: originalFetch.preconnect })
    const submitter = createProjectExpenseSubmitter()
    const input = { date: '2026-11-19', category: '外注費', amountMinor: 120_000, currency: 'JPY' }
    const receipt = new File(['x'], 'receipt.pdf', { type: 'application/pdf', lastModified: 1 })

    await expect(submitter.submit('token', 'core-team', 'atlas', input, [receipt])).rejects.toBeDefined()
    failExpense = false
    const stored = await submitter.submit('token', 'core-team', 'atlas', input, [receipt])

    expect(stored.id).toBe('x1')
    expect(calls.filter((call) => call.startsWith('PUT'))).toHaveLength(1)
    expect(expenseKeys).toHaveLength(2)
    expect(expenseKeys[1]).toBe(expenseKeys[0])
    // A new submission after the stored one is a new request.
    await submitter.submit('token', 'core-team', 'atlas', input, [receipt])
    expect(expenseKeys[2]).not.toBe(expenseKeys[0])
  })

  test('finishes a receipt upload whose completion went unanswered and keeps each unanswered submission key', async () => {
    const calls: string[] = []
    const completionKeys: (string | null)[] = []
    const expenseKeys: (string | null)[] = []
    let failComplete = true
    let failExpense = true
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url.replace(/^.*\/projects\/atlas/u, '')}`)
      if (url.startsWith('https://upload.example/')) return new Response(null, { status: 200 })
      if (url.endsWith('/complete')) {
        completionKeys.push(new Headers(init?.headers).get('Idempotency-Key'))
        if (failComplete) throw new TypeError('network')
        return Response.json({ file: { id: 'file-1' }, version: { id: 'v1' } })
      }
      if (url.endsWith('/expenses')) {
        expenseKeys.push(new Headers(init?.headers).get('Idempotency-Key'))
        if (failExpense) throw new TypeError('network')
        return Response.json({ expense: submitted }, { status: 201 })
      }
      return Response.json({
        file: { id: 'file-1' },
        version: { id: 'v1' },
        upload: { url: 'https://upload.example/receipt', method: 'PUT', headers: {}, maxSizeBytes: 1_000 },
      }, { status: 201 })
    }, { preconnect: originalFetch.preconnect })
    const submitter = createProjectExpenseSubmitter()
    const input = { date: '2026-11-19', category: '外注費', amountMinor: 120_000, currency: 'JPY' }
    const receipt = new File(['x'], 'receipt.pdf', { type: 'application/pdf', lastModified: 1 })
    // A different file with the same name, size, date, and type is another receipt.
    const lookalike = new File(['y'], 'receipt.pdf', { type: 'application/pdf', lastModified: 1 })

    await expect(submitter.submit('token', 'core-team', 'atlas', input, [receipt])).rejects.toBeDefined()
    failComplete = false
    await expect(submitter.submit('token', 'core-team', 'atlas', input, [receipt])).rejects.toBeDefined()
    // The retry completed the same version with the same key, without a new session or upload.
    expect(calls.filter((call) => call.endsWith('/uploads'))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith('PUT'))).toHaveLength(1)
    expect(completionKeys).toHaveLength(2)
    expect(completionKeys[1]).toBe(completionKeys[0])

    // Another submission in between does not drop the first one's key.
    await expect(submitter.submit('token', 'core-team', 'atlas', { ...input, amountMinor: 1 }, [lookalike])).rejects.toBeDefined()
    expect(calls.filter((call) => call.endsWith('/uploads'))).toHaveLength(2)
    failExpense = false
    await submitter.submit('token', 'core-team', 'atlas', input, [receipt])
    expect(expenseKeys[2]).toBe(expenseKeys[0])
    expect(expenseKeys[1]).not.toBe(expenseKeys[0])
  })

  test('shows approved expenses in the actual cost of the budget report and pending ones apart', () => {
    const markup = renderToStaticMarkup(
      <ProjectBudgetReportPanel
        budgetEditPath="/budget"
        locale="ja"
        onChangeRange={() => undefined}
        onExport={() => undefined}
        onRetry={() => undefined}
        range={{ from: projectBudgetReportFixture.from, to: projectBudgetReportFixture.to }}
        renderLink={(path, children) => <a href={path}>{children}</a>}
        report={{ ...projectBudgetReportFixture, approvedExpenseByCurrency: { JPY: 32_000 }, pendingExpenseByCurrency: { JPY: 5_000 } }}
        t={createTranslator('ja')}
      />,
    )
    expect(markup).toContain('￥500,000')
    expect(markup).toContain('うち承認済みの経費 ￥32,000')
    expect(markup).toContain('承認待ちの経費 ￥5,000')
  })
})
