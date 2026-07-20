import type { Meta, StoryObj } from '@storybook/react-vite'
import { createMemoryRouter, RouterProvider } from 'react-router'
import {
  publicDocumentFixture,
  publicWhiteboardFixture,
} from './fixtures'
import { SharedDocumentScreen } from './SharedDocumentPage'

/**
 * Expiring public link の read-only route Storybook metadata です。
 */
const meta = {
  args: {
    allowExport: true,
    document: publicDocumentFixture,
    locale: 'ja',
    onExport: async () => undefined,
  },
  component: SharedDocumentScreen,
  parameters: {
    layout: 'fullscreen',
  },
  render: (args) => {
    const router = createMemoryRouter(
      [
        {
          path: '/share/documents/:shareToken',
          element: <SharedDocumentScreen {...args} />,
        },
      ],
      {
        initialEntries: ['/share/documents/storybook-token'],
      },
    )

    return <RouterProvider router={router} />
  },
  title: 'Application/Documents/Public Share',
} satisfies Meta<typeof SharedDocumentScreen>

export default meta

/**
 * Public share stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Safe block renderer を使う公開 page です。
 */
export const Page: Story = {}

/**
 * Read-only SVG canvas を使う公開 Whiteboard です。
 */
export const Whiteboard: Story = {
  args: {
    document: publicWhiteboardFixture,
  },
}

/**
 * Revoked、expired、または不正 token の unavailable state です。
 */
export const Unavailable: Story = {
  args: {
    document: undefined,
    errorMessage: 'Document share was not found.',
  },
}
