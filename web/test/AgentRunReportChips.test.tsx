import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { listWorkItemAgentRunReports } from '../src/work-items/api/agentRuns'
import { agentRunHandoffReportFixture, agentRunReportFixture } from '../src/work-items/agentRunFixtures'
import {
  indexAgentRunReportsByComment,
  isAgentRunReportAwaitingDecision,
  readAgentRunArtifactText,
} from '../src/work-items/model/agentRunReportDisplay'
import { AgentRunReportChips } from '../src/work-items/ui/AgentRunReportChips'
import { createAgentRunReportChipsLabels } from '../src/work-items/ui/agentRunReportLabels'
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

describe('Agent Run report display', () => {
  test('indexes reports by comment and keeps the newest for a comment', () => {
    const older = { ...agentRunReportFixture, sequence: 1, kind: 'progress' as const }
    const byComment = indexAgentRunReportsByComment([agentRunReportFixture, older, { ...agentRunHandoffReportFixture, commentId: 'comment-2' }])
    expect(byComment.get('comment-1')?.sequence).toBe(2)
    expect(byComment.get('comment-2')?.kind).toBe('handoff')
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
    expect(html).toContain(`title="${labels.decisionNeeded}"`)
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
