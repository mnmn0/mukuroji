import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { SWRConfig } from 'swr'
import type { CurrentUser } from '../auth/api'
import { clearAuthSession, saveAuthSession } from '../auth/session'
import { projectDirectoryFixtures } from '../projects/fixtures'
import { teamWorkItemConfigurationFixture } from '../work-items/fixtures'
import {
  requestFormFixture,
  requestSubmissionFixture,
} from './fixtures'
import { RequestIntakePage } from './RequestIntakePage'

/** Request intake page Story が再現する API / permission 状態です。 */
type RequestIntakeStoryScenario =
  | 'queue-member'
  | 'forms-admin'
  | 'loading'
  | 'queue-error'

const storyAccessToken = 'storybook-request-intake-token'

/**
 * Request intake page の Storybook metadata です。
 */
const meta = {
  title: 'Application/Requests/Intake Page',
  component: RequestIntakePage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, context) => (
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <MemoryRouter initialEntries={[
          typeof context.parameters.requestRoute === 'string'
            ? context.parameters.requestRoute
            : '/requests',
        ]}>
          <Story />
        </MemoryRouter>
      </SWRConfig>
    ),
  ],
} satisfies Meta<typeof RequestIntakePage>

export default meta

/**
 * Request intake page stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Form 管理権限を持たない member の queue 表示です。
 */
export const QueueMember: Story = {
  beforeEach: () => installRequestIntakeStory('queue-member'),
}

/**
 * Form 管理権限を持つ admin の forms 表示です。
 */
export const FormsAdministrator: Story = {
  beforeEach: () => installRequestIntakeStory('forms-admin'),
  parameters: { requestRoute: '/requests?view=forms' },
}

/**
 * 認証済み Workspace shell の初期 loading 表示です。
 */
export const Loading: Story = {
  beforeEach: () => installRequestIntakeStory('loading'),
}

/**
 * Queue API が失敗したときの error 表示です。
 */
export const QueueError: Story = {
  beforeEach: () => installRequestIntakeStory('queue-error'),
}

function installRequestIntakeStory(scenario: RequestIntakeStoryScenario) {
  const originalFetch = globalThis.fetch

  saveAuthSession({
    accessToken: storyAccessToken,
    expiresAt: Date.now() + 60 * 60 * 1_000,
    remember: false,
    tokenType: 'Bearer',
  })

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.origin,
    )

    if (url.pathname === '/api/auth/me') {
      if (scenario === 'loading') return new Promise<Response>(() => undefined)
      return jsonResponse(createStoryUser(scenario === 'forms-admin' ? 'admin' : 'member'))
    }

    if (url.pathname === '/api/teams/projects') {
      return jsonResponse({ teams: projectDirectoryFixtures })
    }

    if (url.pathname === '/api/request-queue') {
      return scenario === 'queue-error'
        ? jsonResponse({ message: '受付キューを読み込めませんでした。' }, 503)
        : jsonResponse({ submissions: [requestSubmissionFixture] })
    }

    if (url.pathname === `/api/request-submissions/${requestSubmissionFixture.id}`) {
      return jsonResponse(requestSubmissionFixture)
    }

    if (url.pathname === '/api/request-forms') {
      return jsonResponse({ forms: [requestFormFixture] })
    }

    if (url.pathname === `/api/request-forms/${requestFormFixture.id}`) {
      return jsonResponse(requestFormFixture)
    }

    if (url.pathname === '/api/teams/core-team/work-item-configuration') {
      return jsonResponse({ configuration: teamWorkItemConfigurationFixture })
    }

    return jsonResponse({ message: `Unexpected Storybook request: ${url.pathname}` }, 404)
  }) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
    clearAuthSession()
  }
}

function createStoryUser(role: CurrentUser['workspaceRole']): CurrentUser {
  return {
    attributes: {
      email: role === 'admin' ? 'admin@example.com' : 'member@example.com',
      name: role === 'admin' ? 'Request administrator' : 'Queue member',
    },
    groups: [],
    isSystemAdmin: false,
    username: `storybook-${role}`,
    workspaceMemberStatus: 'active',
    workspaceRole: role,
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}
