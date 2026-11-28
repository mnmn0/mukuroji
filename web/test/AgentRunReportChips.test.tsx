import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { answerAgentRunReport, listWorkItemAgentRunReports, listWorkItemArtifactStatuses } from '../src/work-items/api/agentRuns'
import { agentRunHandoffReportFixture, agentRunReportFixture } from '../src/work-items/agentRunFixtures'
import {
  agentRunReportAnswerDraftKey,
  indexAgentRunReportsByComment,
  isAgentRunReportAwaitingDecision,
  readAgentRunArtifactText,
  selectAgentRunReportLoadFailure,
  selectAgentRunReportsForWorkItem,
} from '../src/work-items/model/agentRunReportDisplay'
import { AgentRunReportChips, AgentRunReportsLoadNotice } from '../src/work-items/ui/AgentRunReportChips'
import {
  createAgentRunArtifactStatusIncompleteNoticeLabels,
  createAgentRunArtifactStatusNoticeLabels,
  createAgentRunReportChipsLabels,
  createAgentRunReportsNoticeLabels,
} from '../src/work-items/ui/agentRunReportLabels'
import { IssueCollaborationPanel } from '../src/issues/ui/IssueCollaborationPanel'
import { collaborationWorkspaceMemberFixtures, issueCollaborationControllerFixture } from '../src/issues/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'

const labels = createAgentRunReportChipsLabels('en')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that answers every request with the given JSON body.
 *
 * @param body - Response body.
 * @param requests - Receives each requested URL.
 */
function answerWith(body: unknown, requests: string[] = []): void {
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }, { preconnect: originalFetch.preconnect })
}

describe('Agent Run report API', () => {
  test('reads a Work Item\'s reports from the Web route', async () => {
    const requests: string[] = []
    answerWith({ items: [agentRunReportFixture], hasMore: false }, requests)
    expect(await listWorkItemAgentRunReports('token', 'core', 'onboarding friction'))
      .toEqual({ items: [agentRunReportFixture], hasMore: false })
    expect(requests[0]).toEndWith('/teams/core/work-items/onboarding%20friction/agent-run-reports')
  })

  test('rejects a response whose report shape or artifact URL is unsupported', async () => {
    for (const items of [
      [{ ...agentRunReportFixture, artifacts: [{ type: 'url', url: 'https://example.test/log?token=secret' }] }],
      [{ ...agentRunReportFixture, artifacts: [{ type: 'url', url: 'javascript:alert(1)' }] }],
      [{ ...agentRunReportFixture, verifications: [{ command: 'bun test', status: 'unknown' }] }],
      [{ ...agentRunReportFixture, kind: 'note' }],
      [{ ...agentRunReportFixture, changedFileCount: -1 }],
    ]) {
      answerWith({ items, hasMore: false })
      await expect(listWorkItemAgentRunReports('token', 'core', 'task-1')).rejects.toMatchObject({ status: 502 })
    }
  })
})

describe('Reported pull request statuses', () => {
  const verified = {
    url: 'https://github.com/example/repo/pull/12', provider: 'github', repository: 'example/repo', number: 12,
    verification: 'verified', checkedAt: '2026-11-26T00:00:00.000Z',
    pullRequest: { state: 'merged', draft: false, headSha: 'a'.repeat(40), checks: 'success', review: 'approved', mergedAt: '2026-11-25T00:00:00.000Z' },
  } as const

  test('reads the statuses from the Web route and rejects a malformed item', async () => {
    const requests: string[] = []
    answerWith({ teamId: 'core', workItemId: 'task-1', items: [verified] }, requests)
    expect(await listWorkItemArtifactStatuses('token', 'core', 'task-1')).toEqual({ teamId: 'core', workItemId: 'task-1', items: [verified] })
    expect(requests[0]).toEndWith('/teams/core/work-items/task-1/artifact-statuses')
    for (const item of [
      { ...verified, pullRequest: undefined },
      { ...verified, verification: 'unverified' },
      { ...verified, provider: 'bitbucket' },
    ]) {
      answerWith({ teamId: 'core', workItemId: 'task-1', items: [item] })
      await expect(listWorkItemArtifactStatuses('token', 'core', 'task-1')).rejects.toMatchObject({ status: 502 })
    }
    answerWith({ teamId: 'core', workItemId: 'other', items: [] })
    await expect(listWorkItemArtifactStatuses('token', 'core', 'task-1')).rejects.toMatchObject({ status: 502 })
    // A read that stopped early keeps the flag, and any other value is rejected.
    answerWith({ teamId: 'core', workItemId: 'task-1', items: [verified], incomplete: true })
    expect(await listWorkItemArtifactStatuses('token', 'core', 'task-1'))
      .toEqual({ teamId: 'core', workItemId: 'task-1', items: [verified], incomplete: true })
    answerWith({ teamId: 'core', workItemId: 'task-1', items: [verified], incomplete: false })
    await expect(listWorkItemArtifactStatuses('token', 'core', 'task-1')).rejects.toMatchObject({ status: 502 })
  })

  test('shows the provider state next to the pull request link, and marks one that was not checked', () => {
    const merged = renderToStaticMarkup(
      <AgentRunReportChips artifactStatuses={new Map([[verified.url, verified]])} labels={labels} report={agentRunReportFixture} />,
    )
    expect(merged).toContain(labels.artifactStatus.states.merged)
    expect(merged).toContain(labels.artifactStatus.reviews.approved)
    // A merged pull request no longer shows its checks.
    expect(merged).not.toContain(labels.artifactStatus.checks.success)

    const unchecked = renderToStaticMarkup(
      <AgentRunReportChips
        artifactStatuses={new Map([[verified.url, {
          url: verified.url, provider: 'github', repository: 'example/repo', number: 12,
          verification: 'unverified', unverifiedReason: 'repository-not-allowed', checkedAt: verified.checkedAt,
        }]])}
        labels={labels}
        report={agentRunReportFixture}
      />,
    )
    expect(unchecked).toContain(labels.artifactStatus.unverified)
    expect(unchecked).toContain(labels.artifactStatus.unverifiedReasons['repository-not-allowed'].replaceAll("'", '&#x27;'))

    const plain = renderToStaticMarkup(<AgentRunReportChips labels={labels} report={agentRunReportFixture} />)
    expect(plain).not.toContain(labels.artifactStatus.unverified)
    expect(plain).not.toContain('data-testid="agent-run-artifact-state"')
  })
})

describe('Agent Run report answers', () => {
  const answer = { body: 'Use staging.', answeredBy: 'member', answeredAt: '2026-10-22T00:10:00.000Z', commentId: 'comment-3' }

  test('posts the answer with its idempotency key and reads the answered report', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({ report: { ...agentRunHandoffReportFixture, answer } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      })
    }, { preconnect: originalFetch.preconnect })
    const answered = await answerAgentRunReport('token', 'core', agentRunHandoffReportFixture, 'Use staging.', {
      idempotencyKey: 'key-1', correlationId: 'correlation-1',
    })
    expect(answered.answer).toEqual(answer)
    expect(requests[0]?.url).toEndWith(
      `/teams/core/work-items/${encodeURIComponent(agentRunHandoffReportFixture.workItemId)}/agent-runs/` +
        `${agentRunHandoffReportFixture.runId}/reports/${agentRunHandoffReportFixture.sequence}/answer`,
    )
    expect(requests[0]?.init?.method).toBe('POST')
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ body: 'Use staging.' }))
    expect(new Headers(requests[0]?.init?.headers).get('Idempotency-Key')).toBe('key-1')
  })

  test('reads a saved answer with its report and rejects a malformed one', async () => {
    answerWith({ items: [{ ...agentRunHandoffReportFixture, answer }], hasMore: false })
    expect((await listWorkItemAgentRunReports('token', 'core', 'task-1')).items[0]?.answer).toEqual(answer)
    answerWith({ items: [{ ...agentRunHandoffReportFixture, answer: { ...answer, body: '' } }], hasMore: false })
    await expect(listWorkItemAgentRunReports('token', 'core', 'task-1')).rejects.toMatchObject({ status: 502 })
    answerWith({ report: agentRunHandoffReportFixture })
    await expect(answerAgentRunReport('token', 'core', agentRunHandoffReportFixture, 'x', {
      idempotencyKey: 'key-2', correlationId: 'correlation-2',
    })).rejects.toMatchObject({ status: 502 })
  })

  test('offers the answer form only on a waiting question and marks an answered one', () => {
    const onAnswer = async () => 'saved' as const
    const waiting = renderToStaticMarkup(<AgentRunReportChips labels={labels} onAnswer={onAnswer} report={agentRunHandoffReportFixture} />)
    expect(waiting).toContain(`>${labels.answer.open}</button>`)
    const readOnly = renderToStaticMarkup(<AgentRunReportChips labels={labels} report={agentRunHandoffReportFixture} />)
    expect(readOnly).not.toContain(`>${labels.answer.open}</button>`)
    const answered = renderToStaticMarkup(
      <AgentRunReportChips labels={labels} onAnswer={onAnswer} report={{ ...agentRunHandoffReportFixture, answer }} />,
    )
    expect(answered).toContain(`<span>${labels.answer.answered}</span>`)
    expect(answered).not.toContain(labels.decisionNeeded)
    expect(answered).not.toContain(`>${labels.answer.open}</button>`)
    expect(answered).not.toContain('workbench-badge-warning')
    const progress = renderToStaticMarkup(<AgentRunReportChips labels={labels} onAnswer={onAnswer} report={agentRunReportFixture} />)
    expect(progress).not.toContain(`>${labels.answer.open}</button>`)
    expect(createAgentRunReportChipsLabels('ja').answer.open).toBe('回答する')
  })

  test('restores an unsent answer when the form mounts again', () => {
    const onAnswer = async () => 'saved' as const
    const restored = renderToStaticMarkup(
      <AgentRunReportChips
        answerDraft={{ open: true, body: 'Use the staging bucket.' }}
        labels={labels}
        onAnswer={onAnswer}
        report={agentRunHandoffReportFixture}
      />,
    )
    expect(restored).toContain('data-testid="agent-run-report-answer-form"')
    expect(restored).toContain('>Use the staging bucket.</textarea>')
    // Drafts are kept per Work Item and report, so one report's text never appears under another.
    const key = agentRunReportAnswerDraftKey('task-1', agentRunHandoffReportFixture)
    expect(agentRunReportAnswerDraftKey('task-1', { ...agentRunHandoffReportFixture, sequence: agentRunHandoffReportFixture.sequence + 1 })).not.toBe(key)
    expect(agentRunReportAnswerDraftKey('task-2', agentRunHandoffReportFixture)).not.toBe(key)
  })
})

describe('Agent Run report display', () => {
  test('indexes reports by comment and keeps the newest for a comment', () => {
    const older = { ...agentRunReportFixture, sequence: 1, kind: 'progress' as const }
    const byComment = indexAgentRunReportsByComment([agentRunReportFixture, older, { ...agentRunHandoffReportFixture, commentId: 'comment-2' }])
    expect(byComment.get('comment-1')?.sequence).toBe(2)
    expect(byComment.get('comment-2')?.kind).toBe('handoff')
  })

  test('shows only reports of the Work Item on screen and none without a session', () => {
    const scope = { accessToken: 'token', teamId: 'core', workItemId: 'onboarding-friction' }
    const other = { ...agentRunReportFixture, workItemId: 'billing-copy', commentId: 'comment-9' }
    const otherTeam = { ...agentRunReportFixture, teamId: 'design', commentId: 'comment-8' }
    expect(selectAgentRunReportsForWorkItem([agentRunReportFixture, other, otherTeam], scope)).toEqual([agentRunReportFixture])
    // Data kept from an earlier read never outlives the session or the Team.
    expect(selectAgentRunReportsForWorkItem([agentRunReportFixture], { ...scope, accessToken: undefined })).toEqual([])
    expect(selectAgentRunReportsForWorkItem([agentRunReportFixture], { ...scope, teamId: undefined })).toEqual([])
    expect(selectAgentRunReportsForWorkItem(undefined, scope)).toEqual([])
  })

  test('marks blockers and hand-offs as awaiting a decision and shortens long link text', () => {
    expect(isAgentRunReportAwaitingDecision('blocker')).toBe(true)
    expect(isAgentRunReportAwaitingDecision('handoff')).toBe(true)
    expect(isAgentRunReportAwaitingDecision('verification')).toBe(false)
    expect(readAgentRunArtifactText({ type: 'pull-request', url: 'https://github.com/a/b/pull/1', label: 'PR 1' })).toBe('PR 1')
    const long = readAgentRunArtifactText({ type: 'commit', url: `https://github.com/example/repo/commit/${'a'.repeat(40)}` })
    expect(long.startsWith('github.com/example/repo/commit/')).toBe(true)
    expect(long.length).toBe(48)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('AgentRunReportChips', () => {
  test('shows the kind, each verification, safe artifact links, and the changed file count', () => {
    const html = renderToStaticMarkup(<AgentRunReportChips labels={labels} report={agentRunReportFixture} />)
    expect(html).toContain('data-testid="agent-run-report-chips"')
    expect(html).toContain('>Verification<')
    expect(html).toContain('bun run server:test')
    expect(html).toContain('title="3,890 tests passed"')
    expect(html).toContain('workbench-badge-danger')
    expect(html).toContain('href="https://github.com/example/repo/pull/12"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('7 files changed')
  })

  test('flags a hand-off for a person and uses the shared locale dictionaries', () => {
    const html = renderToStaticMarkup(<AgentRunReportChips labels={labels} report={agentRunHandoffReportFixture} />)
    expect(html).toContain('workbench-badge-warning')
    // The hint is visible text, so touch and keyboard users read it too.
    expect(html).toContain(`<span>${labels.decisionNeeded}</span>`)
    const verification = renderToStaticMarkup(<AgentRunReportChips labels={labels} report={agentRunReportFixture} />)
    expect(verification).not.toContain(labels.decisionNeeded)
    const ja = createAgentRunReportChipsLabels('ja')
    expect(ja.kinds.handoff).toBe(createTranslator('ja')('workItems.agentRunReports.kind.handoff'))
    expect(ja.kinds.handoff).not.toBe(labels.kinds.handoff)
  })

  test('renders under the comment the report was saved with and nowhere else', () => {
    const byComment = indexAgentRunReportsByComment([agentRunReportFixture])
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={issueCollaborationControllerFixture}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
        renderCommentDetails={(comment) => {
          const report = byComment.get(comment.id)
          return report ? <AgentRunReportChips labels={labels} report={report} /> : null
        }}
      />,
    )
    expect(html.match(/data-testid="agent-run-report-chips"/g)).toHaveLength(1)
    const card = html.indexOf('id="comment-comment-1"')
    expect(card).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('data-testid="agent-run-report-chips"')).toBeGreaterThan(card)
  })
})

describe('AgentRunReportsLoadNotice', () => {
  test('reports a failed read with a retry action instead of showing no reports', () => {
    const noticeLabels = createAgentRunReportsNoticeLabels('en')
    const html = renderToStaticMarkup(<AgentRunReportsLoadNotice labels={noticeLabels} onRetry={() => undefined} />)
    expect(html).toContain('role="status"')
    expect(html).toContain(noticeLabels.loadError)
    expect(html).toContain(`>${noticeLabels.retry}</button>`)
    expect(createAgentRunReportsNoticeLabels('ja').retry).toBe(createTranslator('ja')('workItems.agentRunReports.retry'))
  })

  test('tells the viewer when pull request statuses could not be checked, with its own retry', () => {
    const statusLabels = createAgentRunArtifactStatusNoticeLabels('en')
    const html = renderToStaticMarkup(
      <AgentRunReportsLoadNotice labels={statusLabels} onRetry={() => undefined} testId="agent-run-artifact-status-load-notice" />,
    )
    expect(html).toContain('data-testid="agent-run-artifact-status-load-notice"')
    expect(html).toContain(statusLabels.loadError)
    // A failed report read wins; a failed status read matters only when a report lists a pull request.
    expect(selectAgentRunReportLoadFailure({ reportsFailed: true, statusesFailed: true, hasPullRequests: true })).toBe('reports')
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: true, hasPullRequests: true })).toBe('artifact-statuses')
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: true, hasPullRequests: false })).toBeUndefined()
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: false, hasPullRequests: true })).toBeUndefined()
  })

  test('tells the viewer when only some pull requests were checked', () => {
    const incompleteLabels = createAgentRunArtifactStatusIncompleteNoticeLabels('en')
    expect(incompleteLabels.loadError).toBe(createTranslator('en')('workItems.agentRunReports.artifactStatus.incomplete'))
    expect(createAgentRunArtifactStatusIncompleteNoticeLabels('ja').loadError)
      .toBe(createTranslator('ja')('workItems.agentRunReports.artifactStatus.incomplete'))
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: false, hasPullRequests: true, statusesIncomplete: true }))
      .toBe('artifact-statuses-incomplete')
    // A failed read wins over an incomplete one, and nothing is said without a pull request.
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: true, hasPullRequests: true, statusesIncomplete: true }))
      .toBe('artifact-statuses')
    expect(selectAgentRunReportLoadFailure({ reportsFailed: false, statusesFailed: false, hasPullRequests: false, statusesIncomplete: true }))
      .toBeUndefined()
  })
})
