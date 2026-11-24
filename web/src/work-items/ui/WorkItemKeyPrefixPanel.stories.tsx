import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemKeyPrefixPanel } from './WorkItemKeyPrefixPanel'

/** Team key prefix setting shown on the Team settings page. */
const meta = {
  title: 'Application/WorkItems/KeyPrefix',
  component: WorkItemKeyPrefixPanel,
  parameters: { layout: 'padded' },
  args: {
    teams: [{ id: 'core-team', name: 'Core' }, { id: 'platform-team', name: 'Platform' }],
    teamId: 'core-team',
    onSelectTeam: () => {},
    settings: { teamId: 'core-team', keyPrefix: 'CT', previousPrefixes: ['CORE'], lastNumber: 128, canManage: true },
    isLoading: false,
    hasLoadError: false,
    onRetry: () => {},
    projectCodeChoices: ['REFERO', 'ROADMAP'],
    isSaving: false,
    onSave: () => {},
    t: createTranslator('ja'),
  },
} satisfies Meta<typeof WorkItemKeyPrefixPanel>

/** Registers the key prefix stories in Storybook. */
export default meta
/** Story type for the key prefix panel. */
type Story = StoryObj<typeof meta>
/** A Team manager choosing a new prefix from Project codes. */
export const Manager: Story = {}
/** A Team without a prefix yet shows the one its first Work Item would get. */
export const Unassigned: Story = {
  args: { settings: { teamId: 'core-team', suggestedKeyPrefix: 'CT', previousPrefixes: [], lastNumber: 0, canManage: true } },
}
/** A Team member sees the prefix read-only. */
export const Member: Story = {
  args: { settings: { teamId: 'core-team', keyPrefix: 'CT', previousPrefixes: [], lastNumber: 12, canManage: false } },
}
/** Another Team already holds the requested prefix. */
export const Taken: Story = { args: { saveResult: 'taken' } }
/** The narrow phone layout. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
