import type { ComponentProps } from 'react'
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import type { CreateEnterpriseMemberRoleAssignmentInput } from '../api'
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
    onCreateMemberRoleAssignment: fn(async () => undefined),
    onCreateRole: fn(async () => undefined),
    onDeleteMapping: fn(async () => undefined),
    onDeleteMemberRoleAssignment: fn(async () => undefined),
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

/**
 * Renders the access tab with a snapshot that keeps the member assignments the story creates.
 *
 * @param props - Access tab props from the story args.
 * @returns The access tab whose assignment list shows each created assignment.
 */
function AccessTabWithAssignments(props: ComponentProps<typeof SecurityAccessTab>) {
  const [snapshot, setSnapshot] = useState(props.snapshot)

  /**
   * Sends the assignment to the story spy, then adds it to the rendered snapshot.
   *
   * @param input - Assignment that the form submitted.
   */
  const createAssignment = async (input: CreateEnterpriseMemberRoleAssignmentInput) => {
    await props.onCreateMemberRoleAssignment?.(input)
    setSnapshot((current) => ({
      ...current,
      memberRoleAssignments: [
        ...current.memberRoleAssignments,
        {
          id: `story-${input.memberKey}-${input.roleId}`,
          memberKey: input.memberKey,
          roleId: input.roleId,
          scopeId: input.scopeId,
          scopeType: input.scopeType,
        },
      ],
    }))
  }

  return (
    <SecurityAccessTab
      {...props}
      snapshot={snapshot}
      onCreateMemberRoleAssignment={createAssignment}
    />
  )
}

/** Assigns the auditor role to one member and shows it in the member assignment list. */
export const AssignMemberRole: Story = {
  args: {
    t: createTranslator('ja'),
  },
  render: (args) => <AccessTabWithAssignments {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const form = within(canvas.getByTestId('security-member-assignment-form'))

    await userEvent.selectOptions(form.getByLabelText('メンバー'), 'auditor@example.com')
    await userEvent.selectOptions(form.getByLabelText('ロール'), 'workspace:auditor')
    await userEvent.click(form.getByRole('button', { name: '割り当てを追加' }))

    await expect(args.onCreateMemberRoleAssignment).toHaveBeenCalledWith({
      memberKey: 'auditor@example.com',
      roleId: 'workspace:auditor',
      scopeId: 'workspace-demo',
      scopeType: 'workspace',
    })
    const table = within(canvas.getByTestId('security-member-assignment-table'))
    const createdRow = (await table.findAllByRole('row')).find((row) => {
      const cells = within(row)
      return cells.queryByText(/auditor@example\.com/) !== null &&
        cells.queryByText('監査担当') !== null
    })
    await expect(createdRow).toBeDefined()
  },
}
