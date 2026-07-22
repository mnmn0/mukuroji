import type { Meta, StoryObj } from '@storybook/react-vite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { EnterpriseSsoCallbackPage } from './EnterpriseSsoCallbackPage'

/** EnterpriseSsoCallbackPage の Storybook metadata です。 */
const meta = {
  title: 'Application/Pages/Enterprise SSO Callback',
  component: EnterpriseSsoCallbackPage,
  parameters: {
    layout: 'fullscreen',
  },
  render: () => {
    const router = createMemoryRouter(
      [
        {
          element: <EnterpriseSsoCallbackPage />,
          path: '/auth/sso/callback',
        },
      ],
      {
        initialEntries: ['/auth/sso/callback?error=access_denied'],
      },
    )

    return <RouterProvider router={router} />
  },
} satisfies Meta<typeof EnterpriseSsoCallbackPage>

export default meta

/** EnterpriseSsoCallbackPage stories の型です。 */
type Story = StoryObj<typeof meta>

/** Authorization request が拒否または期限切れになった安全な再試行表示です。 */
export const RequestRejected: Story = {}
