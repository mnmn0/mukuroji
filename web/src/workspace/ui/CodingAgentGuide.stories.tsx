import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { codingAgentConfigurationTemplate } from '../model/codingAgentGuide'
import { CodingAgentGuide } from './CodingAgentGuide'

/** Installs an isolated clipboard stub and restores the browser after the story. */
function installClipboardStub(writeText: (text: string) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return () => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
}

const writeConfiguration = fn<(text: string) => Promise<void>>(async () => undefined)

const meta = {
  args: { t: createTranslator('en') },
  component: CodingAgentGuide,
  decorators: [(Story) => (
    <MemoryRouter>
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <div className="mx-auto max-w-6xl"><Story /></div>
      </main>
    </MemoryRouter>
  )],
  parameters: { layout: 'fullscreen' },
  title: 'Application/Workspace/Coding Agent Guide',
} satisfies Meta<typeof CodingAgentGuide>

/** Storybook metadata for the real MCP setup and shared-workflow guide. */
export default meta

/** Story shape for the localized coding-agent connection guide. */
type Story = StoryObj<typeof meta>

/** Japanese connection instructions with no credential inputs. */
export const Japanese: Story = {
  args: { t: createTranslator('ja') },
}

/** Verifies that the copy action writes only the credential-free configuration. */
export const CopyConfiguration: Story = {
  beforeEach: () => {
    writeConfiguration.mockClear()
    return installClipboardStub(writeConfiguration)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Copy configuration' }))
    await expect(canvas.getByRole('status')).toHaveTextContent('Configuration template copied.')
    await expect(canvas.getByRole('button', { name: 'Copy configuration' })).toHaveFocus()
    await expect(writeConfiguration).toHaveBeenCalledWith(codingAgentConfigurationTemplate)
    await expect(canvas.getByRole('link', { name: 'Open Developer settings' })).toHaveAttribute('href', '/settings')
  },
}

/** Verifies blocked clipboard access leaves the whole template selected for manual copy. */
export const ClipboardUnavailable: Story = {
  beforeEach: () => installClipboardStub(async () => { throw new Error('Clipboard unavailable') }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Copy configuration' }))
    await expect(canvas.getByRole('status')).toHaveTextContent('Clipboard access failed.')
    const configuration = canvas.getByRole('textbox', { name: 'MCP connection configuration without credentials' })
    await expect(configuration).toHaveFocus()
    await expect(configuration).toHaveProperty('selectionStart', 0)
    await expect(configuration).toHaveProperty('selectionEnd', codingAgentConfigurationTemplate.length)
  },
}
