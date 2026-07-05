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
  render: () => {
    clearAuthSession()

    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <LoginPage />,
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
