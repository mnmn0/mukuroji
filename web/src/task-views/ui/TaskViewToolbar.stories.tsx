import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { useState } from 'react'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  TaskViewToolbar,
  type TaskViewOption,
  type TaskViewToolbarProps,
} from './TaskViewToolbar'
import type { TaskViewPresentationSettings } from '../model/taskViewPresentation'

const t = createTranslator('ja')
const views: TaskViewOption[] = [
  {
    canEdit: true,
    favorite: true,
    id: 'personal-active',
    isPersonalDefault: true,
    isTeamDefault: false,
    name: '自分の進行中タスク',
    pinned: true,
    visibility: 'personal',
  },
  {
    canEdit: true,
    favorite: false,
    id: 'team-delivery',
    isPersonalDefault: false,
    isTeamDefault: true,
    name: 'Delivery review',
    pinned: false,
    teamId: 'core-team',
    visibility: 'team',
  },
  {
    canEdit: false,
    favorite: false,
    id: 'workspace-roadmap',
    isPersonalDefault: false,
    isTeamDefault: false,
    name: 'Workspace roadmap',
    pinned: false,
    visibility: 'shared',
  },
]
const settings: TaskViewPresentationSettings = {
  columns: [
    { field: 'title', pin: 'start', width: 300 },
    { field: 'status', width: 160 },
    { field: 'assignee', width: 180 },
    { field: 'dueDate', pin: 'end', width: 150 },
  ],
  density: 'comfortable',
  display: {
    showArchived: false,
    showAssigneeAvatars: true,
    showCompleted: false,
    showEmptyGroups: true,
    showSubtasks: true,
    wrapTitles: false,
  },
  groupBy: 'status',
  sort: [{ direction: 'asc', field: 'priority' }],
}

/** Keeps presentation controls interactive while still recording Storybook action callbacks. */
function StatefulTaskViewToolbar(props: TaskViewToolbarProps) {
  const [currentSettings, setCurrentSettings] = useState(props.settings)
  return (
    <TaskViewToolbar
      {...props}
      settings={currentSettings}
      onSettingsChange={(nextSettings) => {
        setCurrentSettings(nextSettings)
        props.onSettingsChange(nextSettings)
      }}
    />
  )
}

const meta = {
  title: 'Application/Task views/View toolbar',
  component: TaskViewToolbar,
  parameters: {
    layout: 'padded',
  },
  args: {
    builtInName: 'テーブル',
    canManageShared: true,
    canSetTeamDefault: true,
    canWrite: true,
    columnOptions: [
      { id: 'title', label: 'タスク名' },
      { id: 'status', label: 'ステータス' },
      { id: 'assignee', label: '担当者' },
      { id: 'dueDate', label: '期限' },
      { id: 'priority', label: '優先度' },
    ],
    groupOptions: [
      { id: 'status', label: 'ステータス' },
      { id: 'assignee', label: '担当者' },
      { id: 'priority', label: '優先度' },
      { id: 'project', label: 'プロジェクト' },
    ],
    isDirty: true,
    onCopyLink: fn(),
    onDelete: fn(),
    onDuplicate: fn(),
    onPatchPreference: fn(),
    onReset: fn(),
    onSaveAs: fn(),
    onSelectView: fn(),
    onSettingsChange: fn(),
    onUpdate: fn(),
    selectedView: views[0],
    settings,
    supportsColumnLayoutMetadata: true,
    supportsEmptyGroups: true,
    t,
    teams: [
      { id: 'core-team', name: 'コアチーム' },
      { id: 'design-team', name: 'デザインチーム' },
    ],
    views,
  },
} satisfies Meta<typeof TaskViewToolbar>

/** Storybook metadata for the shared task-view lifecycle toolbar. */
export default meta

/** Story type for the shared task-view lifecycle toolbar. */
type Story = StoryObj<typeof meta>

/** Shows a selected personal view with temporary URL overrides. */
export const TemporaryOverrides: Story = {
  render: (args) => <StatefulTaskViewToolbar {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const settingsButton = canvas.getByRole('button', { name: '表示オプション' })

    await expect(canvas.getByText('一時的な変更あり')).toBeInTheDocument()
    await userEvent.click(settingsButton)
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true')
    await expect(canvas.getByTestId('task-view-settings')).toBeInTheDocument()

    const firstSortField = canvas.getByRole('combobox', { name: '1 番目の項目' })
    const firstSortDirection = canvas.getByRole('combobox', { name: '1 番目の方向' })
    await userEvent.selectOptions(firstSortField, 'assignee')
    await expect(firstSortField).toHaveFocus()
    await userEvent.selectOptions(firstSortDirection, 'desc')
    await expect(firstSortDirection).toHaveFocus()
    await userEvent.click(canvas.getByRole('button', { name: '並び順を追加' }))
    const secondSortField = canvas.getByRole('combobox', { name: '2 番目の項目' })
    await expect(secondSortField).toHaveFocus()
    await userEvent.click(canvas.getByRole('button', { name: '2 番目の並び順を削除' }))
    await expect(canvas.getByRole('button', { name: '1 番目の並び順を削除' })).toHaveFocus()

    const titleWidth = canvas.getByRole('spinbutton', { name: 'タスク名列の幅' })
    await userEvent.clear(titleWidth)
    await userEvent.type(titleWidth, '360')
    await userEvent.tab()
    await expect(titleWidth).toHaveValue(360)

    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'ステータス列の固定位置' }),
      'end',
    )
    const groupDirections = canvas.getAllByRole('combobox', { name: '方向' })
    const primaryGroupDirection = groupDirections[0]
    if (!primaryGroupDirection) throw new Error('Expected a primary group direction control.')
    await userEvent.selectOptions(primaryGroupDirection, 'desc')

    await userEvent.click(canvas.getByRole('button', { name: 'タスク名列を右へ移動' }))
    const columnSettings = canvas.getAllByTestId('task-view-column-setting')
    await expect(columnSettings[0]).toHaveAttribute('aria-label', 'ステータス列の設定')

    const archived = canvas.getByRole('checkbox', { name: 'アーカイブ済みの項目を表示' })
    const avatars = canvas.getByRole('checkbox', { name: '担当者アバターを表示' })
    const emptyGroups = canvas.getByRole('checkbox', { name: '空のグループを表示' })
    await userEvent.click(archived)
    await userEvent.click(avatars)
    await userEvent.click(emptyGroups)
    await expect(archived).toBeChecked()
    await expect(avatars).not.toBeChecked()
    await expect(emptyGroups).not.toBeChecked()
  },
}

/** Shows a migrated Team view with the fallback warning visible. */
export const MigratedTeamView: Story = {
  args: {
    isDirty: false,
    migrationWarnings: ['削除された列「legacy-risk」を取り除きました。'],
    selectedView: views[1],
  },
}

/** Verifies that an effective Team default can still become the personal default. */
export const TeamEffectiveDefault: Story = {
  args: {
    isDirty: false,
    selectedView: views[1],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('tasks.action.more') }))
    const personalDefaultButton = canvas.getByRole('menuitem', {
      name: t('search.saved.makeDefault'),
    })

    await expect(personalDefaultButton).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(personalDefaultButton)
    await expect(args.onPatchPreference).toHaveBeenCalledWith('team-delivery', {
      isDefault: true,
    })
  },
}

/** Shows the compact built-in fallback used for inaccessible permalinks. */
export const BuiltInFallback: Story = {
  args: {
    canManageShared: false,
    isDirty: false,
    migrationWarnings: ['参照権限を失ったビューの代わりに標準ビューを表示しています。'],
    selectedView: undefined,
  },
}

/** Shows a selected shared view without saved-view mutation controls. */
export const ReadOnlySelectedView: Story = {
  args: {
    canManageShared: false,
    canWrite: false,
    selectedView: views[2],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Workspace roadmap')).toBeInTheDocument()
    await expect(canvas.queryByRole('button', { name: t('tasks.action.more') }))
      .not.toBeInTheDocument()
    await expect(canvas.queryByText(t('taskViews.saveAs'))).not.toBeInTheDocument()
    await expect(canvas.getByText(t('taskViews.reset'))).toBeInTheDocument()
  },
}

/** Verifies that Team visibility is unavailable when the server authorizes no Team destination. */
export const PersonalOnlySave: Story = {
  args: {
    canManageShared: false,
    isDirty: false,
    teams: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('taskViews.saveAs') }))

    await expect(canvas.getByRole('dialog')).toBeInTheDocument()
    await expect(canvas.queryByRole('option', { name: t('search.saved.team') }))
      .not.toBeInTheDocument()
    await expect(canvas.queryByRole('option', { name: t('search.saved.shared') }))
      .not.toBeInTheDocument()
  },
}
