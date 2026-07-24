import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { enterpriseSecuritySnapshotFixture } from '../fixtures'
import type { EnterpriseSecurityScopeOption } from '../model/enterpriseSecurityForms'
import { SecurityAccessTab } from './SecurityAccessTab'

const scopeOptions: EnterpriseSecurityScopeOption[] = [
  { id: 'workspace-demo', name: 'Workspace', type: 'workspace' },
  { id: 'core-team', name: 'Core team', type: 'team' },
  { id: 'refero', name: 'Refero · Core team', type: 'project' },
]

/** Storybook metadata for the independently rendered access tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Access',
  component: SecurityAccessTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    scopeOptions,
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onCreateMapping: fn(async () => undefined),
    onCreateRole: fn(async () => undefined),
    onDeleteMapping: fn(async () => undefined),
    onPreviewRoleImpact: fn(async () => ({
      assignmentCount: 0,
      blocking: false,
      confirmationToken: 'storybook-role-impact',
      mappingCount: 0,
      removedPermissionIds: [],
      serviceAccountCount: 0,
      warnings: [],
    })),
    onRequestDeleteRole: fn(),
    onRequestUpdateRole: fn(),
    onUpdateMapping: fn(async () => undefined),
    onUpdateRole: fn(async () => undefined),
  },
} satisfies Meta<typeof SecurityAccessTab>

export default meta

/** Story type for the enterprise security access tab. */
type Story = StoryObj<typeof meta>

/** Builds a directory-group mapping from the tab-owned form state. */
export const CreateMappingInteraction: Story = {
  play: async ({ args, canvasElement }) => {
    const form = within(
      within(canvasElement).getByTestId('security-mapping-form'),
    )
    await userEvent.type(
      form.getByRole('textbox', { name: /Directory group name/i }),
      'Security team',
    )
    await userEvent.type(
      form.getByRole('textbox', { name: /Directory group ID/i }),
      'group-security',
    )
    await userEvent.selectOptions(
      form.getByRole('combobox', { name: /Role/i }),
      'workspace:member',
    )
    await userEvent.click(form.getByRole('button', { name: /Add mapping/i }))
    await expect(args.onCreateMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryGroupId: 'group-security',
        directoryGroupName: 'Security team',
        roleId: 'workspace:member',
      }),
    )
  },
}
