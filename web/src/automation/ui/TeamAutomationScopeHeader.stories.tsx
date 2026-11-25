import type { Meta, StoryObj } from '@storybook/react-vite'
import { TeamAutomationScopeHeader } from './TeamAutomationScopeHeader'

/** TeamAutomationScopeHeader の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Team Scope Header',
  component: TeamAutomationScopeHeader,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    locale: 'ja',
    scopesFailed: false,
    selectedTeamId: 'core-team',
    teams: [
      { id: 'core-team', name: 'Core team' },
      { id: 'design-team', name: 'Design team' },
    ],
    onRetryScopes: () => undefined,
    onSelectTeam: () => undefined,
  },
} satisfies Meta<typeof TeamAutomationScopeHeader>

/** TeamAutomationScopeHeader の Storybook metadata です。 */
export default meta

/** TeamAutomationScopeHeader story の型です。 */
type Story = StoryObj<typeof meta>

/** Team を選んで、その Team の定義を表示している状態です。 */
export const Default: Story = {}

/** 管理できる範囲を読み込めず、再読み込みを出している状態です。 */
export const ScopesFailed: Story = {
  args: { scopesFailed: true },
}
