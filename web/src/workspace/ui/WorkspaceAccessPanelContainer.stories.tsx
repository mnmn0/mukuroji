import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { SWRConfig } from 'swr'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { WorkspaceAccess, WorkspaceInvitation } from '../api'
import { WorkspaceAccessPanelContainer } from './WorkspaceAccessPanel'

const initialAccessToken = 'storybook-workspace-access-token'
const rotatedAccessToken = 'storybook-rotated-workspace-access-token'
const invitationEmail = 'retry.member@example.com'
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Story fetch mock が記録する mutation context header です。
 */
interface StoryMutationContextHeaders {
  /**
   * リクエストを追跡する X-Correlation-Id header です。
   */
  correlationId: string | null
  /**
   * mutation の重複実行を防ぐ Idempotency-Key header です。
   */
  idempotencyKey: string | null
}

const ownerMember = {
  createdAt: '2026-07-01T00:00:00.000Z',
  email: 'owner@example.com',
  id: 'member-owner',
  memberKey: 'owner@example.com',
  name: 'Owner User',
  role: 'owner',
  status: 'active',
  updatedAt: '2026-07-11T08:00:00.000Z',
  version: 4,
} as const

const workspaceAccessFixture = {
  capabilities: {
    canInvite: true,
    canManageAdmins: true,
    canManageMembers: true,
  },
  currentMember: ownerMember,
  invitations: [],
  members: [ownerMember],
} satisfies WorkspaceAccess

const staleOwnerMember = {
  ...ownerMember,
  name: 'Stale session owner',
}

const staleWorkspaceAccessFixture = {
  ...workspaceAccessFixture,
  currentMember: staleOwnerMember,
  members: [staleOwnerMember],
} satisfies WorkspaceAccess

const rotatedOwnerMember = {
  ...ownerMember,
  name: 'Rotated session owner',
}

const rotatedWorkspaceAccessFixture = {
  ...workspaceAccessFixture,
  currentMember: rotatedOwnerMember,
  members: [rotatedOwnerMember],
} satisfies WorkspaceAccess

const invitationFixture = {
  createdAt: '2026-07-17T00:00:00.000Z',
  deliveryStatus: 'sent',
  email: invitationEmail,
  expiresAt: '2026-07-24T00:00:00.000Z',
  id: 'invitation-retry-member',
  identityOwnership: 'workspace-created',
  lastSentAt: '2026-07-17T00:01:00.000Z',
  role: 'member',
  status: 'pending',
  updatedAt: '2026-07-17T00:01:00.000Z',
  version: 1,
} satisfies WorkspaceInvitation

const retainedContextScenario = {
  invitationRequestContexts: [] as StoryMutationContextHeaders[],
  invitationRequestCount: 0,
  snapshotRequestCount: 0,
  reset() {
    this.invitationRequestContexts = []
    this.invitationRequestCount = 0
    this.snapshotRequestCount = 0
  },
  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = readStoryRequest(input, init)

    if (request.method === 'GET' && request.url.pathname === '/api/workspace/access') {
      this.snapshotRequestCount += 1

      if (this.snapshotRequestCount === 2) {
        throw new TypeError('Storybook snapshot transport failure')
      }

      return jsonResponse(workspaceAccessFixture)
    }

    if (request.method === 'POST' && request.url.pathname === '/api/workspace/invitations') {
      this.invitationRequestCount += 1
      this.invitationRequestContexts.push(readMutationContextHeaders(request.headers))

      if (this.invitationRequestCount <= 2) {
        throw new TypeError('Storybook mutation transport failure')
      }

      return jsonResponse({ invitation: invitationFixture })
    }

    throw new Error(`Unexpected Storybook request: ${request.method} ${request.url.pathname}`)
  },
}

const accessTokenScenario = {
  invitationAccessTokens: [] as string[],
  invitationRequestContexts: [] as StoryMutationContextHeaders[],
  oldSnapshotRequestStarted: false,
  resolveOldSnapshotRequest: undefined as ((response: Response) => void) | undefined,
  reset() {
    this.releaseOldSnapshotRequestIfPending()
    this.invitationAccessTokens = []
    this.invitationRequestContexts = []
    this.oldSnapshotRequestStarted = false
  },
  releaseOldSnapshotRequest() {
    const resolve = this.resolveOldSnapshotRequest

    if (!resolve) {
      throw new Error('The old-session snapshot request has not started')
    }

    this.resolveOldSnapshotRequest = undefined
    resolve(jsonResponse(staleWorkspaceAccessFixture))
  },
  releaseOldSnapshotRequestIfPending() {
    const resolve = this.resolveOldSnapshotRequest

    if (resolve) {
      this.resolveOldSnapshotRequest = undefined
      resolve(jsonResponse(staleWorkspaceAccessFixture))
    }
  },
  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = readStoryRequest(input, init)
    const authorization = request.headers.get('Authorization') ?? ''

    if (request.method === 'GET' && request.url.pathname === '/api/workspace/access') {
      if (authorization === `Bearer ${initialAccessToken}`) {
        if (this.invitationRequestContexts.length === 0) {
          return jsonResponse(workspaceAccessFixture)
        }

        if (this.resolveOldSnapshotRequest) {
          throw new Error('The old-session snapshot request is already pending')
        }

        this.oldSnapshotRequestStarted = true

        return new Promise<Response>((resolve) => {
          this.resolveOldSnapshotRequest = resolve
        })
      }

      if (authorization === `Bearer ${rotatedAccessToken}`) {
        return jsonResponse(rotatedWorkspaceAccessFixture)
      }
    }

    if (request.method === 'POST' && request.url.pathname === '/api/workspace/invitations') {
      this.invitationAccessTokens.push(authorization)
      this.invitationRequestContexts.push(readMutationContextHeaders(request.headers))

      if (authorization === `Bearer ${initialAccessToken}`) {
        throw new TypeError('Storybook mutation transport failure')
      }

      return jsonResponse({ invitation: invitationFixture })
    }

    throw new Error(`Unexpected Storybook request: ${request.method} ${request.url.pathname}`)
  },
}

function readStoryRequest(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined
  const url = request
    ? new URL(request.url)
    : new URL(String(input), globalThis.location.origin)

  return {
    headers: new Headers(init?.headers ?? request?.headers),
    method: init?.method ?? request?.method ?? 'GET',
    url,
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

function readMutationContextHeaders(headers: Headers): StoryMutationContextHeaders {
  return {
    correlationId: headers.get('X-Correlation-Id'),
    idempotencyKey: headers.get('Idempotency-Key'),
  }
}

function expectValidMutationContextHeaders(context: StoryMutationContextHeaders | undefined) {
  expect(context).toBeDefined()
  expect(context?.correlationId).toBeTruthy()
  expect(context?.correlationId).toEqual(expect.stringMatching(uuidV4Pattern))
  expect(context?.idempotencyKey).toBeTruthy()
  expect(context?.idempotencyKey).toEqual(expect.stringMatching(uuidV4Pattern))
}

function installStoryFetch(fetchImplementation: typeof fetch) {
  const originalFetch = globalThis.fetch

  globalThis.fetch = fetchImplementation

  return () => {
    globalThis.fetch = originalFetch
  }
}

function WorkspaceAccessTokenSwitchHarness(
  props: Parameters<typeof WorkspaceAccessPanelContainer>[0],
) {
  const [accessToken, setAccessToken] = useState(props.accessToken)
  const switchAccessTokenLabel = createAccessTokenSwitchLabel(props.locale)

  return (
    <div className="grid gap-4">
      <button
        className="workbench-button-secondary min-h-10 w-fit px-4"
        type="button"
        onClick={() => setAccessToken(rotatedAccessToken)}
      >
        {switchAccessTokenLabel}
      </button>
      <WorkspaceAccessPanelContainer {...props} accessToken={accessToken} />
    </div>
  )
}

function createAccessTokenSwitchLabel(locale: Locale) {
  return createTranslator(locale)('workspace.access.action.switchAccessToken')
}

const meta = {
  args: {
    accessToken: initialAccessToken,
    locale: 'ja',
  },
  component: WorkspaceAccessPanelContainer,
  decorators: [
    (Story) => (
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <Story />
      </SWRConfig>
    ),
  ],
  parameters: {
    controls: {
      disable: true,
    },
    layout: 'padded',
  },
  title: 'Application/Settings/Workspace Access Panel/Container',
} satisfies Meta<typeof WorkspaceAccessPanelContainer>

/**
 * WorkspaceAccessPanelContainer の Storybook metadata です。
 */
export default meta

/**
 * WorkspaceAccessPanelContainer stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * transport failure の context を保持し、snapshot 回復後だけ破棄する interaction です。
 */
export const RetainedContextUntilSnapshotRecovery: Story = {
  beforeEach: () => {
    retainedContextScenario.reset()
    return installStoryFetch(retainedContextScenario.fetch.bind(retainedContextScenario))
  },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement)
    const emailInput = await canvas.findByRole('textbox', { name: 'メールアドレス' })
    const submitButton = canvas.getByRole('button', { name: '招待を作成' })

    await userEvent.type(emailInput, invitationEmail)

    await step('snapshot refresh も失敗した場合は context を保持する', async () => {
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(retainedContextScenario.snapshotRequestCount).toBe(2)
        expect(retainedContextScenario.invitationRequestContexts).toHaveLength(1)
        expect(submitButton).not.toBeDisabled()
      })

      expectValidMutationContextHeaders(
        retainedContextScenario.invitationRequestContexts[0],
      )
    })

    await step('同じ mutation は保持した context を再利用する', async () => {
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(retainedContextScenario.snapshotRequestCount).toBe(3)
        expect(retainedContextScenario.invitationRequestContexts).toHaveLength(2)
        expect(submitButton).not.toBeDisabled()
      })

      const initialContext = retainedContextScenario.invitationRequestContexts[0]
      const retryContext = retainedContextScenario.invitationRequestContexts[1]

      expectValidMutationContextHeaders(initialContext)
      expectValidMutationContextHeaders(retryContext)
      expect(retryContext?.correlationId).toBe(initialContext?.correlationId)
      expect(retryContext?.idempotencyKey).toBe(initialContext?.idempotencyKey)
    })

    await step('snapshot refresh 成功後は次の mutation に新しい context を使う', async () => {
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(retainedContextScenario.snapshotRequestCount).toBe(4)
        expect(retainedContextScenario.invitationRequestContexts).toHaveLength(3)
        expect(emailInput).toHaveValue('')
      })

      const recoveredContext = retainedContextScenario.invitationRequestContexts[2]
      const retainedContext = retainedContextScenario.invitationRequestContexts[1]

      expectValidMutationContextHeaders(retainedContext)
      expectValidMutationContextHeaders(recoveredContext)
      expect(recoveredContext?.correlationId).not.toBe(retainedContext?.correlationId)
      expect(recoveredContext?.idempotencyKey).not.toBe(retainedContext?.idempotencyKey)
    })
  },
}

/**
 * access token 切り替え時に旧 snapshot と retained context を新しい session へ持ち越さない interaction です。
 */
export const NewRunnerAfterAccessTokenChange: Story = {
  beforeEach: () => {
    accessTokenScenario.reset()
    const restoreFetch = installStoryFetch(accessTokenScenario.fetch.bind(accessTokenScenario))

    return () => {
      accessTokenScenario.releaseOldSnapshotRequestIfPending()
      restoreFetch()
    }
  },
  render: (args) => <WorkspaceAccessTokenSwitchHarness {...args} />,
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement)
    const firstEmailInput = await canvas.findByRole('textbox', { name: 'メールアドレス' })
    const switchAccessTokenLabel = createAccessTokenSwitchLabel(args.locale)

    await userEvent.type(firstEmailInput, invitationEmail)

    await step('最初の session で transport failure context を保持する', async () => {
      const submitButton = canvas.getByRole('button', { name: '招待を作成' })

      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(accessTokenScenario.invitationAccessTokens).toHaveLength(1)
        expect(accessTokenScenario.invitationRequestContexts).toHaveLength(1)
        expect(accessTokenScenario.oldSnapshotRequestStarted).toBe(true)
        expect(submitButton).toBeDisabled()
      })

      expect(accessTokenScenario.invitationAccessTokens).toEqual([
        `Bearer ${initialAccessToken}`,
      ])
      expectValidMutationContextHeaders(accessTokenScenario.invitationRequestContexts[0])
    })

    await step('旧 refresh 保留中でも新しい token は新しい context を使う', async () => {
      await userEvent.click(canvas.getByRole('button', { name: switchAccessTokenLabel }))
      await canvas.findByText('Rotated session owner')

      const rotatedEmailInput = await canvas.findByRole('textbox', { name: 'メールアドレス' })
      const submitButton = canvas.getByRole('button', { name: '招待を作成' })

      expect(accessTokenScenario.resolveOldSnapshotRequest).toBeDefined()
      expect(rotatedEmailInput).toHaveValue('')
      expect(submitButton).not.toBeDisabled()
      await userEvent.type(rotatedEmailInput, invitationEmail)
      await userEvent.click(submitButton)
      await waitFor(() => {
        expect(accessTokenScenario.invitationAccessTokens).toHaveLength(2)
        expect(accessTokenScenario.invitationRequestContexts).toHaveLength(2)
        expect(rotatedEmailInput).toHaveValue('')
      })

      expect(accessTokenScenario.invitationAccessTokens).toEqual([
        `Bearer ${initialAccessToken}`,
        `Bearer ${rotatedAccessToken}`,
      ])
      const initialContext = accessTokenScenario.invitationRequestContexts[0]
      const rotatedContext = accessTokenScenario.invitationRequestContexts[1]

      expectValidMutationContextHeaders(initialContext)
      expectValidMutationContextHeaders(rotatedContext)
      expect(rotatedContext?.correlationId).not.toBe(initialContext?.correlationId)
      expect(rotatedContext?.idempotencyKey).not.toBe(initialContext?.idempotencyKey)
      expect(accessTokenScenario.resolveOldSnapshotRequest).toBeDefined()
    })

    await step('旧 session の refresh 完了後も新しい token の表示を維持する', async () => {
      accessTokenScenario.releaseOldSnapshotRequest()

      await waitFor(() => {
        expect(canvas.getByText('Rotated session owner')).toBeVisible()
        expect(canvas.queryByText('Stale session owner')).not.toBeInTheDocument()
        expect(canvas.getByRole('button', { name: '招待を作成' })).not.toBeDisabled()
      })
    })
  },
}
