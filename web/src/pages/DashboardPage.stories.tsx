import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, waitFor, within } from 'storybook/test'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { DashboardPage } from './DashboardPage'
import type { CurrentUser, DashboardSummary } from '../auth/api'
import type { AuthSession } from '../auth/session'

const storySession: AuthSession = {
  accessToken: 'storybook-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  tokenType: 'Bearer',
  remember: false,
}

const storyUser: CurrentUser = {
  username: 'demo@example.com',
  attributes: {
    email: 'demo@example.com',
  },
}

const storySummary: DashboardSummary = {
  projects: 9,
  tasks: 27,
  blocked: 4,
  updatedAt: '2026-05-30T00:00:00.000Z',
  source: 'dynamodb',
}

const defaultArgs = {
  initialLocale: 'ja',
  getSession: () => storySession,
  clearSession: () => undefined,
  loadCurrentUser: async () => storyUser,
} satisfies Partial<Parameters<typeof DashboardPage>[0]>

/**
 * DashboardPage の Storybook meta です。title、component、layout、router wrapper を定義します。
 */
const meta = {
  title: 'Application/Pages/DashboardPage',
  component: DashboardPage,
  parameters: {
    layout: 'fullscreen',
    controls: {
      disable: true,
    },
  },
  render: (args) => {
    const router = createMemoryRouter(
      [
        {
          path: '/dashboard',
          element: <DashboardPage {...args} />,
        },
      ],
      {
        initialEntries: ['/dashboard'],
      },
    )

    return <RouterProvider router={router} />
  },
} satisfies Meta<typeof DashboardPage>

export default meta

/**
 * DashboardPage stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * ダッシュボード集計値の読み込み中表示です。
 */
export const SummaryLoading: Story = {
  args: {
    ...defaultArgs,
    loadDashboardSummary: () => new Promise<DashboardSummary>(() => undefined),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await waitFor(() => expect(canvas.getByText('demo@example.com')).toBeTruthy())
    await waitFor(() => expect(canvas.getAllByText('...')).toHaveLength(3))
  },
}

/**
 * DynamoDB 由来のダッシュボード集計値を表示する状態です。
 */
export const SummaryLoaded: Story = {
  args: {
    ...defaultArgs,
    loadDashboardSummary: async () => storySummary,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await waitFor(() => expect(canvas.getByText('9')).toBeTruthy())
    expect(canvas.getByText('27')).toBeTruthy()
    expect(canvas.getByText('4')).toBeTruthy()
  },
}

/**
 * 集計値取得に失敗し、fallback の集計値を表示する状態です。
 */
export const SummaryFallback: Story = {
  args: {
    ...defaultArgs,
    loadDashboardSummary: async () => {
      throw new Error('Storybook dashboard summary failure')
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await waitFor(() => expect(canvas.getByText('3')).toBeTruthy())
    expect(canvas.getByText('18')).toBeTruthy()
    expect(canvas.getByText('2')).toBeTruthy()
  },
}
