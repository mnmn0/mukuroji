import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import type { TaskViewPresentationSettings } from '../src/task-views/model/taskViewPresentation'
import {
  TaskViewSettingsPanel,
  TaskViewToolbar,
  TaskViewPreferenceButton,
  type TaskViewOption,
  type TaskViewToolbarProps,
} from '../src/task-views/ui/TaskViewToolbar'

const t = createTranslator('ja')
const settings: TaskViewPresentationSettings = {
  columns: [
    { field: 'title', pin: 'start', width: 300 },
    { field: 'status', width: 160 },
  ],
  density: 'comfortable',
  display: {
    showArchived: false,
    showAssigneeAvatars: true,
    showCompleted: true,
    showEmptyGroups: true,
    showSubtasks: true,
    wrapTitles: false,
  },
  groupBy: 'status',
  sort: [
    { direction: 'asc', field: 'priority' },
    { direction: 'desc', field: 'dueDate' },
  ],
}
const editableTeamView: TaskViewOption = {
  canEdit: true,
  favorite: true,
  id: 'delivery-review',
  isPersonalDefault: false,
  isTeamDefault: true,
  name: 'Delivery review',
  pinned: true,
  teamId: 'core-team',
  visibility: 'team',
}
const readOnlySharedView: TaskViewOption = {
  canEdit: false,
  favorite: false,
  id: 'workspace-roadmap',
  isPersonalDefault: false,
  isTeamDefault: false,
  name: 'Workspace roadmap',
  pinned: false,
  visibility: 'shared',
}

describe('TaskViewToolbar', () => {
  test('exposes pressed state only for preference toggles', () => {
    const inactiveToggle = renderToStaticMarkup(
      <TaskViewPreferenceButton
        active={false}
        label="既定にする"
        onClick={() => undefined}
      />,
    )
    const lifecycleAction = renderToStaticMarkup(
      <TaskViewPreferenceButton label="複製" onClick={() => undefined} />,
    )

    expect(inactiveToggle).toContain('aria-pressed="false"')
    expect(lifecycleAction).not.toContain('aria-pressed')
  })

  test('renders selected-view update, save-as, reset, permalink, and settings entry points', () => {
    const html = renderToolbar({
      isDirty: true,
      selectedView: editableTeamView,
    })

    expect(html).toContain('data-testid="task-view-toolbar"')
    expect(html).toContain('Delivery review')
    expect(html).toContain('一時的な変更あり')
    expect(html).toContain('上書き')
    expect(html).toContain('新しいビューとして保存')
    expect(html).toContain('変更をリセット')
    expect(html).toContain('aria-label="ビューのリンクをコピー"')
    expect(html).toContain('表示オプション')
    expect(html).toContain('aria-haspopup="menu"')
  })

  test('suppresses write-only entry points for the read-only built-in fallback', () => {
    const html = renderToolbar({
      canManageShared: false,
      canWrite: false,
      isDirty: false,
      selectedView: undefined,
      views: [],
    })

    expect(html).toContain('標準テーブル')
    expect(html).toContain('保存済み')
    expect(html).not.toContain('新しいビューとして保存')
    expect(html).not.toContain('上書き')
    expect(html).not.toContain('変更をリセット')
    expect(html).not.toContain(`aria-label="${t('tasks.action.more')}"`)
    expect(html).toContain('aria-label="ビューのリンクをコピー"')
    expect(html).toContain('表示オプション')
  })

  test('suppresses overwrite while retaining temporary-reset for a non-editable shared view', () => {
    const html = renderToolbar({
      isDirty: true,
      selectedView: readOnlySharedView,
    })

    expect(html).toContain('Workspace roadmap')
    expect(html).not.toContain('>上書き<')
    expect(html).toContain('>変更をリセット<')
  })

  test('hides saved-view mutation controls for a read-only selected view', () => {
    const html = renderToolbar({
      canWrite: false,
      isDirty: true,
      selectedView: editableTeamView,
    })

    expect(html).toContain('Delivery review')
    expect(html).not.toContain('>上書き<')
    expect(html).not.toContain('新しいビューとして保存')
    expect(html).not.toContain(`aria-label="${t('tasks.action.more')}"`)
    expect(html).toContain('>変更をリセット<')
    expect(html).toContain('aria-label="ビューのリンクをコピー"')
    expect(html).toContain('表示オプション')
  })

  test('announces transport errors and permission-safe migration fallbacks separately', () => {
    const html = renderToolbar({
      errorMessage: 'Revision conflict',
      migrationWarnings: [
        '削除された列 risk を取り除きました。',
        '参照権限のない status を非表示にしました。',
      ],
    })

    expect(html).toContain('role="alert"')
    expect(html).toContain('Revision conflict')
    expect(html).toContain('role="status"')
    expect(html).toContain('利用できない表示設定を取り除きました。')
    expect(html).toContain('<li>削除された列 risk を取り除きました。</li>')
    expect(html).toContain('<li>参照権限のない status を非表示にしました。</li>')
  })

  test('keeps the lifecycle row wrapping and view trigger width bounded for narrow screens', () => {
    const html = renderToolbar({ selectedView: editableTeamView })

    expect(html).toContain('sm:flex sm:flex-wrap sm:items-center sm:justify-between')
    expect(html).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(html).toContain('w-full min-w-0 items-center')
    expect(html).toContain('sm:max-w-[min(320px,70vw)]')
  })

  test('fails closed when Team-default permission is omitted', () => {
    expect(renderToolbar({})).toContain('data-can-set-team-default="false"')
    expect(renderToolbar({ canSetTeamDefault: true })).toContain(
      'data-can-set-team-default="true"',
    )
  })

  test('renders lossless column, grouping, sort, and implemented display controls', () => {
    const html = renderToStaticMarkup(
      <TaskViewSettingsPanel
        columnOptions={[
          { id: 'title', label: 'タスク名' },
          { id: 'status', label: 'ステータス' },
        ]}
        groupOptions={[
          { id: 'priority', label: '優先度' },
          { id: 'dueDate', label: '期限' },
          { id: 'assignee', label: '担当者' },
        ]}
        onChange={() => undefined}
        requiredColumnIds={['title']}
        settings={settings}
        supportsColumnLayoutMetadata
        supportsEmptyGroups
        supportsKeyboardSelection={false}
        supportsLayoutPresentation
        supportsSubtasks={false}
        t={t}
      />,
    )

    expect(html.match(/data-testid="task-view-sort-rule"/g)?.length).toBe(2)
    expect(html).toContain('1 番目の項目')
    expect(html).toContain('2 番目の方向')
    expect(html).toContain('aria-label="1 番目の並び順を削除"')
    expect(html).toContain('並び順を追加')
    expect(html.indexOf('value="priority"')).toBeLessThan(html.indexOf('value="dueDate"'))
    expect(html.match(/data-testid="task-view-column-setting"/g)?.length).toBe(2)
    expect(html).toContain('aria-label="タスク名列の幅"')
    expect(html).toContain('aria-label="タスク名列の固定位置"')
    expect(html).toContain('aria-label="ステータス列を左へ移動"')
    expect(html).toContain('value="300"')
    expect(html).toContain('アーカイブ済みの項目を表示')
    expect(html).toContain('担当者アバターを表示')
    expect(html).toContain('空のグループを表示')
    expect(html).toContain('グループ')
    expect(html).toContain('方向')
    expect(html).not.toContain(t('taskViews.keyboard'))
  })
})

/** Renders the toolbar with inert callbacks and focused per-test overrides. */
function renderToolbar(overrides: Partial<TaskViewToolbarProps>): string {
  return renderToStaticMarkup(
    <TaskViewToolbar
      builtInName="標準テーブル"
      canManageShared
      canWrite
      columnOptions={[
        { id: 'title', label: 'タスク名' },
        { id: 'status', label: 'ステータス' },
      ]}
      groupOptions={[
        { id: 'status', label: 'ステータス' },
        { id: 'assignee', label: '担当者' },
      ]}
      isDirty={false}
      onCopyLink={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onPatchPreference={() => undefined}
      onReset={() => undefined}
      onSaveAs={() => undefined}
      onSelectView={() => undefined}
      onSettingsChange={() => undefined}
      onUpdate={() => undefined}
      settings={settings}
      t={t}
      teams={[{ id: 'core-team', name: 'コアチーム' }]}
      views={[editableTeamView, readOnlySharedView]}
      {...overrides}
    />,
  )
}
