import type { Meta, StoryObj } from '@storybook/react-vite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { clearAuthSession } from '../auth/session'
import { LoginPage } from './LoginPage'

const meta = {
  title: 'Application/Pages/LoginPage',
  component: LoginPage,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => {
    clearAuthSession()

    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <LoginPage {...args} />,
        },
        {
          path: '/dashboard',
          element: <div />,
        },
      ],
      {
        initialEntries: ['/'],
      },
    )

    return <RouterProvider router={router} />
  },
} satisfies Meta<typeof LoginPage>

/**
 * LoginPage の Storybook meta です。
 */
export default meta

/**
 * LoginPage stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 作業台プレビュー付きログイン画面です。
 */
export const Default: Story = {}

/**
 * Cognito が初回ログインの新しいパスワードを要求した状態です。
 */
export const NewPasswordRequired: Story = {
  args: {
    initialChallenge: {
      challenge: 'NEW_PASSWORD_REQUIRED',
      email: 'invited.member@example.com',
      session: 'storybook-cognito-session',
    },
  },
}

/**
 * パスワード変更後の Workspace 更新に失敗し、通常ログインから復旧できる案内です。
 */
export const ChallengeRecovery: Story = {
  args: {
    initialChallenge: {
      challenge: 'NEW_PASSWORD_REQUIRED',
      email: 'invited.member@example.com',
      session: 'storybook-cognito-session',
    },
    initialChallengeFailed: true,
  },
}
