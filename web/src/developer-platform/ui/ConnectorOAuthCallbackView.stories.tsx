import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { ConnectorOAuthCallbackView } from './ConnectorOAuthCallbackView'

const meta = {
  args: {
    settingsPath: '/settings?developerSection=connectors',
    status: 'completing',
    t: createTranslator('ja'),
  },
  component: ConnectorOAuthCallbackView,
  decorators: [(Story) => (
    <MemoryRouter>
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    </MemoryRouter>
  )],
  parameters: { layout: 'fullscreen' },
  title: 'Application/Developer Platform/Connector OAuth Callback',
} satisfies Meta<typeof ConnectorOAuthCallbackView>

/** Storybook metadata for the page an external service returns to after a connector sign-in. */
export default meta

/** Story shape for the connector OAuth callback page. */
type Story = StoryObj<typeof meta>

/** Shown while the signed-in member's session finishes the connection. */
export const Completing: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('接続を完了しています')
  },
}

/** Shown when the server refuses the flow, for example because someone else started it. */
export const Failed: Story = {
  args: { status: 'failed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert')).toHaveTextContent('接続を完了できませんでした。')
    await expect(canvas.getByRole('link', { name: '連携の設定に戻る' }))
      .toHaveAttribute('href', '/settings?developerSection=connectors')
  },
}

/** English copy for the failure state. */
export const FailedEnglish: Story = {
  args: { status: 'failed', t: createTranslator('en') },
}
