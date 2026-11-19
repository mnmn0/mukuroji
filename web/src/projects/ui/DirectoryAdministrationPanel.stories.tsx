import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { DirectoryAdministrationPanel } from './DirectoryAdministrationPanel'

const teams: DirectoryAdministrationTeam[] = [
  {
    id: 'core-team',
    nameJa: 'コアチーム',
    nameEn: 'Core Team',
    projects: [
      { id: 'refero', nameJa: 'Refero', nameEn: 'Refero', tone: 'blue' },
      { id: 'billing', nameJa: '請求基盤', nameEn: 'Billing', tone: 'green' },
      {
        id: 'legacy',
        nameJa: '旧基盤',
        nameEn: 'Legacy',
        tone: 'yellow',
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'design',
    nameJa: 'デザイン',
    nameEn: 'Design',
    projects: [{ id: 'brand', nameJa: 'ブランド刷新', nameEn: 'Brand refresh', tone: 'purple' }],
  },
  {
    id: 'sales',
    nameJa: '営業',
    nameEn: 'Sales',
    archivedAt: '2026-06-07T00:00:00.000Z',
    projects: [],
  },
]

/** Resolves an action as successful without calling the API. */
const succeed = async () => true

const meta = {
  title: 'Projects/DirectoryAdministrationPanel',
  component: DirectoryAdministrationPanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    teams,
    t: createTranslator('ja'),
    onRenameTeam: succeed,
    onRenameProject: succeed,
    onMoveTeam: succeed,
    onMoveProject: succeed,
    onRestoreTeam: succeed,
    onRestoreProject: succeed,
  },
} satisfies Meta<typeof DirectoryAdministrationPanel>

export default meta

type Story = StoryObj<typeof meta>

/** Active Teams and Projects with move and rename actions, and restorable archived rows. */
export const Default: Story = {}

/** Opens the rename form of a Project with its names and color. */
export const RenamingProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: '請求基盤 の名前を変更' }))
    await expect(canvas.getByLabelText('日本語名')).toHaveValue('請求基盤')
  },
}

/** Shows the conflict message after another change got there first. */
export const Conflict: Story = {
  args: {
    errorMessage: createTranslator('ja')('projects.administration.error.conflict'),
  },
}
