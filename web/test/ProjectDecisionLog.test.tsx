import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectDecisionEntry } from '@mukuroji/contracts'
import { getTeamDecisionLog } from '../src/projects/api/decisionLog'
import {
  fromDateTimeLocalValue,
  isAdrSourceUrl,
  toProjectDecisionEntryInput,
  toProjectDecisionFormValues,
} from '../src/projects/model/projectDecisionForm'
import { useSaveProjectDecision } from '../src/projects/mutations/useSaveProjectDecision'
import { loadTeamDecisionNotes } from '../src/projects/queries/useTeamDecisionNotes'
import { ProjectDecisionLogPanel } from '../src/projects/ui/ProjectDecisionLogPanel'
import { RecordDecisionDialog } from '../src/projects/ui/RecordDecisionDialog'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** A recorded decision with every optional field. */
const decision: ProjectDecisionEntry = {
  id: 'd1',
  title: '検索は S3 Vectors にする',
  content: 'OpenSearch Serverless は使わない。',
  rationale: '常時課金を避けるため。',
  deciderMemberIds: ['pm@example.com'],
  deciderNote: '顧客 A社 山田さん',
  decidedAt: '2026-11-27T01:00:00.000Z',
  relatedWorkItemIds: ['wi-1'],
  sources: [
    { url: 'https://example.slack.com/archives/C1/p1', label: 'Slack thread' },
    { url: 'https://github.com/o/r/blob/main/docs/adr/0114-decision-log.md' },
  ],
  status: 'active',
  origin: 'project',
  recordedByMemberId: 'pm@example.com',
  revision: 1,
  createdAt: '2026-11-28T00:00:00.000Z',
  updatedAt: '2026-11-28T00:00:00.000Z',
}

describe('decision form model', () => {
  test('round-trips a decision through the form values', () => {
    const values = toProjectDecisionFormValues(decision)
    expect(fromDateTimeLocalValue(values.decidedAtLocal)).toBe('2026-11-27T01:00:00.000Z')
    expect(toProjectDecisionEntryInput(values, 'project')).toEqual({
      title: decision.title,
      content: decision.content,
      rationale: decision.rationale,
      deciderMemberIds: decision.deciderMemberIds,
      deciderNote: decision.deciderNote,
      decidedAt: decision.decidedAt,
      relatedWorkItemIds: decision.relatedWorkItemIds,
      sources: decision.sources,
      status: decision.status,
      origin: decision.origin,
    })
  })

  test('keeps the stored decision time to the millisecond while the time input is unchanged', () => {
    const precise = { ...decision, decidedAt: '2026-11-27T01:00:45.500Z' }
    const values = toProjectDecisionFormValues(precise)
    expect(toProjectDecisionEntryInput({ ...values, title: 'renamed' }, 'project').decidedAt).toBe('2026-11-27T01:00:45.500Z')
    const changed = toProjectDecisionEntryInput({ ...values, decidedAtLocal: '2026-11-26T10:00' }, 'project').decidedAt
    expect(changed).toBe(fromDateTimeLocalValue('2026-11-26T10:00'))
  })

  test('drops empty optional fields and empty source rows, and prefills a new decision', () => {
    const values = toProjectDecisionFormValues(undefined, {
      title: 'Work Item title',
      relatedWorkItemIds: ['wi-1'],
    }, new Date('2026-11-28T03:04:00.000Z'))
    const input = toProjectDecisionEntryInput({
      ...values,
      content: ' 内容 ',
      rationale: ' ',
      sources: [{ url: ' ' }],
      supersededByEntryId: 'd2',
    }, 'work-item')
    expect(input).toEqual({
      title: 'Work Item title',
      content: '内容',
      decidedAt: '2026-11-28T03:04:00.000Z',
      relatedWorkItemIds: ['wi-1'],
      status: 'active',
      origin: 'work-item',
    })
  })

  test('recognizes ADR links', () => {
    expect(isAdrSourceUrl('https://github.com/o/r/blob/main/docs/adr/0114-decision-log.md')).toBe(true)
    expect(isAdrSourceUrl('https://github.com/o/r/issues/830')).toBe(false)
    expect(isAdrSourceUrl('not a url')).toBe(false)
  })
})

describe('Project decision log panel', () => {
  test('shows what, why, who, related Work Items, and sources, marking ADR links', () => {
    const html = renderToStaticMarkup(
      <ProjectDecisionLogPanel
        canEdit
        entries={[decision, { ...decision, id: 'd0', title: '古い決定', status: 'superseded', supersededByEntryId: 'd1' }]}
        formatDateTime={(value) => value.slice(0, 10)}
        hasLoadError={false}
        isLoading={false}
        memberOptions={[{ id: 'pm@example.com', label: 'PM 佐藤' }]}
        t={createTranslator('ja')}
        workItemOptions={[{ id: 'wi-1', label: 'MUK-1 検索' }]}
        onReload={() => undefined}
        onSave={async () => undefined}
      />,
    )
    expect(html).toContain('検索は S3 Vectors にする')
    expect(html).toContain('常時課金を避けるため。')
    expect(html).toContain('決めた人: PM 佐藤, 顧客 A社 山田さん')
    expect(html).toContain('関連: MUK-1 検索')
    expect(html).toContain('href="https://example.slack.com/archives/C1/p1"')
    expect(html).toContain('ADR: ')
    expect(html).toContain('rel="noopener noreferrer"')
    // Superseded decisions are hidden until the viewer asks for them.
    expect(html).not.toContain('古い決定')
    expect(html).toContain('data-testid="project-decision-log-add"')
  })

  test('hides editing for a viewer', () => {
    const html = renderToStaticMarkup(
      <ProjectDecisionLogPanel
        canEdit={false}
        entries={[decision]}
        formatDateTime={(value) => value}
        hasLoadError={false}
        isLoading={false}
        memberOptions={[]}
        t={createTranslator('en')}
        onReload={() => undefined}
        onSave={async () => undefined}
      />,
    )
    expect(html).not.toContain('project-decision-log-add')
    expect(html).not.toContain('project-decision-edit')
  })
})

describe('Team decision log API', () => {
  test('sends the filters and rejects a response for another Team', async () => {
    const requested: string[] = []
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response(JSON.stringify({
        teamId: 'core-team',
        truncated: false,
        items: [{ kind: 'decision', projectId: 'atlas', decidedAt: decision.decidedAt, entry: decision }],
      }), { status: 200 })
    }, { preconnect: originalFetch.preconnect })
    const response = await getTeamDecisionLog('token', 'core-team', { keyword: 'S3', projectId: 'atlas' })
    expect(response.items).toHaveLength(1)
    expect(requested[0]).toContain('/teams/core-team/decision-log?q=S3&projectId=atlas')
    await expect(getTeamDecisionLog('token', 'other-team', {})).rejects.toThrow()
  })
})

describe('Team decision notes', () => {
  test('marks the list as cut short when search repeats a cursor', async () => {
    let calls = 0
    globalThis.fetch = Object.assign(async () => {
      calls += 1
      return new Response(JSON.stringify({ schemaVersion: 1, results: [], nextCursor: 'same' }), { status: 200 })
    }, { preconnect: originalFetch.preconnect })
    const notes = await loadTeamDecisionNotes('token', 'core-team', { keyword: '', projectId: '' })
    expect(notes).toEqual({ notes: [], truncated: true })
    expect(calls).toBe(2)
  })

  test('ends normally when search has no next page', async () => {
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ schemaVersion: 1, results: [] }), { status: 200 }), {
      preconnect: originalFetch.preconnect,
    })
    expect(await loadTeamDecisionNotes('token', 'core-team', { keyword: '', projectId: '' })).toEqual({ notes: [], truncated: false })
  })
})

describe('record decision dialog', () => {
  test('reopens a failed save with the same form instead of a fresh prefill', () => {
    const values = toProjectDecisionFormValues(undefined, { title: '前回送った決定' })
    const html = renderToStaticMarkup(
      <RecordDecisionDialog
        origin="document"
        prefill={{ title: '新しい下書き' }}
        projects={[{ teamId: 'core-team', id: 'atlas', name: 'Atlas' }]}
        save={async () => undefined}
        t={createTranslator('ja')}
        unsentDraft={{ projectKey: JSON.stringify(['core-team', 'atlas']), values }}
        onClose={() => undefined}
        onRecorded={() => undefined}
      />,
    )
    expect(html).toContain('前回送った決定')
    expect(html).not.toContain('新しい下書き')
  })

  test('keeps the decided time of a failed save, so the retried request is the same one', () => {
    const values = { ...toProjectDecisionFormValues(undefined, { title: '前回送った決定' }), decidedAtLocal: '2026-01-02T03:04' }
    const sent = toProjectDecisionEntryInput(values, 'document')
    const html = renderToStaticMarkup(
      <RecordDecisionDialog
        origin="document"
        prefill={{ title: '新しい下書き' }}
        projects={[{ teamId: 'core-team', id: 'atlas', name: 'Atlas' }]}
        save={async () => undefined}
        t={createTranslator('ja')}
        unsentDraft={{ projectKey: JSON.stringify(['core-team', 'atlas']), values }}
        onClose={() => undefined}
        onRecorded={() => undefined}
      />,
    )
    // The reopened form shows the time that was sent, not the time it was reopened, and turns
    // back into the same request body.
    expect(html).toContain('value="2026-01-02T03:04"')
    expect(toProjectDecisionEntryInput(values, 'document')).toEqual(sent)
  })
})

describe('saving a decision', () => {
  /**
   * Mounts the save hook once and returns its save function, like one screen that is later left.
   *
   * @returns The save function of that mount.
   */
  function mountSave() {
    let save: ReturnType<typeof useSaveProjectDecision> | undefined
    /** Captures the hook's save function. */
    function Capture() {
      save = useSaveProjectDecision({ accessToken: 'token' })
      return null
    }
    renderToStaticMarkup(<Capture />)
    if (!save) throw new Error('The save hook did not mount.')
    return save
  }

  test('reuses the Idempotency-Key of a save that got no answer, even from a new mount', async () => {
    const keys: (string | null)[] = []
    globalThis.fetch = async (_input, init) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key'))
      return keys.length === 1
        ? new Response(JSON.stringify({ code: 'Unavailable' }), { status: 503 })
        : Response.json({ teamId: 'core-team', projectId: 'atlas', entry: decision }, { status: 201 })
    }
    const input = toProjectDecisionEntryInput(toProjectDecisionFormValues(undefined, { title: '再送する決定' }), 'work-item')
    await expect(mountSave()('core-team', 'atlas', undefined, input)).rejects.toThrow()
    // The screen was left and shown again, so the hook is a new mount with an empty state.
    expect(await mountSave()('core-team', 'atlas', undefined, input)).toEqual(decision)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })
})
