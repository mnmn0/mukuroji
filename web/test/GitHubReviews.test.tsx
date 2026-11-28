import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { readPullRequestInbox, saveGitHubRepositoryLink } from '../src/features/github-reviews/api/githubReviews'
import { createdInboxFixture, githubReviewTeamsFixture, repositoryLinksFixture, toReviewInboxFixture } from '../src/features/github-reviews/fixtures'
import { GitHubLoginPanel } from '../src/features/github-reviews/ui/GitHubLoginPanel'
import { GitHubRepositoryLinksPanel } from '../src/features/github-reviews/ui/GitHubRepositoryLinksPanel'
import { PullRequestInbox, type PullRequestInboxProps } from '../src/features/github-reviews/ui/PullRequestInbox'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Callback that ignores its call. */
const noop = () => undefined

/**
 * Renders the inbox with stubbed callbacks.
 *
 * @param overrides - Props to replace.
 * @returns Static markup.
 */
function renderInbox(overrides: Partial<PullRequestInboxProps> = {}): string {
  const names = new Map<string, string>(githubReviewTeamsFixture.map((team) => [team.id, team.name]))
  return renderToStaticMarkup(
    <MemoryRouter>
      <PullRequestInbox
        formatDateTime={(value) => value.slice(0, 10)}
        hasLoadError={false}
        inbox={toReviewInboxFixture}
        isLoading={false}
        loginSettingsPath="/settings/personal#settings-github"
        t={createTranslator('ja')}
        teamName={(teamId) => names.get(teamId)}
        view="to-review"
        onReload={noop}
        onViewChange={noop}
        {...overrides}
      />
    </MemoryRouter>,
  )
}

test('groups pull requests by section and shows failed checks and conflicts', () => {
  const html = renderInbox()
  expect(html.indexOf('pull-request-section-ready-to-merge')).toBeLessThan(html.indexOf('pull-request-section-open'))
  expect(html).toContain('acme/web#31')
  expect(html).toContain('unit-tests, lint')
  expect(html).toContain('conflict あり')
  expect(html).toContain('https://github.com/acme/app/pull/12')
  expect(html).toContain('Web')
  expect(html).not.toContain('pull-request-section-merged')
})

test('shows the merged section and the draft badge of the member\'s own pull requests', () => {
  const html = renderInbox({ view: 'created', inbox: createdInboxFixture })
  expect(html).toContain('pull-request-section-merged')
  expect(html).toContain('Draft')
  expect(html).toContain('CI 実行中')
})

test('asks for a GitHub login and explains a missing App', () => {
  expect(renderInbox({ inbox: { configured: true, view: 'to-review', items: [] } })).toContain('/settings/personal#settings-github')
  expect(renderInbox({ inbox: { configured: false, view: 'to-review', items: [] } })).toContain('GitHub 連携はまだ設定されていません')
  expect(renderInbox({ inbox: { ...toReviewInboxFixture, items: [] } })).toContain('レビューを頼まれている pull request はありません')
})

test('reads the inbox and rejects a pull request link outside GitHub', async () => {
  const requests: string[] = []
  let body: unknown = toReviewInboxFixture
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(JSON.stringify(body), { status: 200 })
  }, { preconnect: originalFetch.preconnect })
  expect((await readPullRequestInbox('token', 'to-review')).items.map((item) => item.number)).toEqual([12, 5, 31])
  expect(requests[0]).toContain('/me/pull-requests?view=to-review')
  body = { ...toReviewInboxFixture, items: [{ ...toReviewInboxFixture.items[0], url: 'https://evil.example/x' }] }
  await expect(readPullRequestInbox('token', 'to-review')).rejects.toMatchObject({ status: 502 })
})

test('sends the revision the administrator saw when moving a link', async () => {
  let sent: { url: string, body: unknown } | undefined
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(input), body: JSON.parse(String(init?.body)) }
    return new Response(JSON.stringify({ ...repositoryLinksFixture.repositories[0], teamId: 'web-team', revision: 2 }), { status: 200 })
  }, { preconnect: originalFetch.preconnect })
  const link = await saveGitHubRepositoryLink('token', '42', { teamId: 'web-team', expectedRevision: 1 }, { idempotencyKey: 'k', correlationId: 'c' })
  expect(link).toMatchObject({ teamId: 'web-team', revision: 2 })
  expect(sent?.url).toContain('/workspace/github/repositories/42')
  expect(sent?.body).toEqual({ teamId: 'web-team', expectedRevision: 1 })
})

test('renders the GitHub settings panels', () => {
  const t = createTranslator('ja')
  const login = renderToStaticMarkup(
    <GitHubLoginPanel githubLogin="demo-user" hasLoadError={false} isLoading={false} operationError="login-taken" t={t} onReload={noop} onRemove={noop} onSave={async () => true} />,
  )
  expect(login).toContain('demo-user')
  expect(login).toContain('別のメンバーが登録しています')
  const links = renderToStaticMarkup(
    <GitHubRepositoryLinksPanel hasLoadError={false} isLoading={false} listing={repositoryLinksFixture} t={t} teams={githubReviewTeamsFixture} onLink={noop} onReload={noop} onUnlink={noop} />,
  )
  expect(links).toContain('acme/app')
  expect(links).toContain('紐付けを外す')
  expect(links).toContain('非公開')
})
