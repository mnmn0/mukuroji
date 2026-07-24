import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../../shared/i18n/i18n'
import { HelpWorkspaceView } from './HelpWorkspaceView'

const meta = {
  args: {
    t: createTranslator('ja'),
  },
  component: HelpWorkspaceView,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/help']}>
        <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
          <div className="mx-auto max-w-5xl">
            <Story />
          </div>
        </main>
      </MemoryRouter>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
  title: 'Application/Workspace/Help',
} satisfies Meta<typeof HelpWorkspaceView>

/** Storybook metadata for the Workspace help navigation view. */
export default meta

/** Story type for the Workspace help navigation view. */
type Story = StoryObj<typeof meta>

/** Standard Japanese Workspace help destinations. */
export const Default: Story = {}

/** English Workspace help destinations. */
export const English: Story = {
  args: {
    t: createTranslator('en'),
  },
}
