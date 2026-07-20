import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkspaceCommandMenu } from './WorkspaceCommandMenu'

/**
 * WorkspaceCommandMenuのStorybook metaです。
 */
const meta = {
  title: 'Application/Search/Command Menu',
  component: WorkspaceCommandMenu,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    currentLocation: '/projects/refero/issues?teamId=core-team',
    isOpen: true,
    locale: 'ja',
    onClose: () => undefined,
    onNavigate: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--workbench-canvas)] p-8">
        <div className="workbench-panel mx-auto max-w-4xl p-8">
          <p className="workbench-eyebrow">Workspace</p>
          <h1 className="workbench-title mt-3 text-page-title">Command menu preview</h1>
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceCommandMenu>

export default meta

/**
 * WorkspaceCommandMenu storiesの型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Project画面でquick createを利用できるcommand menuです。
 */
export const ProjectContext: Story = {}

/**
 * 英語localeのcommand menuです。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}

/**
 * Mobile viewportで全幅に近いcommand menuを確認する状態です。
 */
export const Mobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
}
