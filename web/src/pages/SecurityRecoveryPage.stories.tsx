import type { Meta, StoryObj } from '@storybook/react-vite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { AuthSession } from '../auth/session'
import { SecurityRecoveryPage } from './SecurityRecoveryPage'

const storySession = {
  accessToken: 'story-access-token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  remember: false,
  tokenType: 'Bearer',
} satisfies AuthSession

/** SecurityRecoveryPage の Storybook metadata です。 */
const meta = {
  title: 'Application/Pages/Security Recovery',
  component: SecurityRecoveryPage,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => {
    const router = createMemoryRouter(
      [
        {
          element: <SecurityRecoveryPage {...args} />,
          path: '/security/recovery',
        },
        {
          element: <div>Dashboard</div>,
          path: '/dashboard',
        },
      ],
      {
        initialEntries: ['/security/recovery'],
      },
    )

    return <RouterProvider router={router} />
  },
} satisfies Meta<typeof SecurityRecoveryPage>

export default meta

/** SecurityRecoveryPage stories の型です。 */
type Story = StoryObj<typeof meta>

/** 事前登録済み emergency administrator が入力する標準 activation form です。 */
export const Default: Story = {
  args: {
    activateAccess: async () => ({
      accountId: 'break-glass-account-1',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      id: 'activation-1',
      startedAt: new Date().toISOString(),
    }),
    getSession: () => storySession,
    onActivated: async () => undefined,
  },
}

/** Recovery form の英語表示です。 */
export const English: Story = {
  args: {
    ...Default.args,
    initialLocale: 'en',
  },
}
