import type { Meta, StoryObj } from '@storybook/react-vite'
import type { OrgStructure } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { OrgStructurePanel, type OrgStructurePanelTeam } from './OrgStructurePanel'

/** Two divisions, one with a department below it. */
const structure: OrgStructure = {
  orgUnits: [
    { id: 'sales', name: '営業本部' },
    { id: 'east', name: '東日本営業部', parentId: 'sales' },
    { id: 'eng', name: '開発本部' },
  ],
  teamAssignments: [
    { teamId: 'sales-hq', orgUnitId: 'sales' },
    { teamId: 'east-team', orgUnitId: 'east' },
    { teamId: 'core', orgUnitId: 'eng' },
  ],
  revision: 4,
}

const teams: OrgStructurePanelTeam[] = [
  { id: 'sales-hq', name: '営業企画' },
  { id: 'east-team', name: '東日本チーム' },
  { id: 'core', name: '基盤チーム' },
  { id: 'design', name: 'デザイン' },
]

const meta = {
  title: 'Projects/OrgStructurePanel',
  component: OrgStructurePanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-[var(--workbench-bg)] p-6 max-[680px]:p-3">
        <Story />
      </div>
    ),
  ],
  args: {
    structure,
    teams,
    isSaving: false,
    t: createTranslator('ja'),
    onSave: async () => true,
  },
} satisfies Meta<typeof OrgStructurePanel>

export default meta

/** Story shape for the OrgUnit structure editor. */
type Story = StoryObj<typeof meta>

/** OrgUnits with Team memberships. */
export const Default: Story = {}

/** A Workspace without OrgUnits yet. */
export const Empty: Story = {
  args: { structure: { orgUnits: [], teamAssignments: [], revision: 0 } },
}

/** A save refused because another administrator saved first, in English. */
export const Conflict: Story = {
  args: {
    t: createTranslator('en'),
    message: { tone: 'error', text: createTranslator('en')('projects.orgUnits.error.conflict') },
  },
}
