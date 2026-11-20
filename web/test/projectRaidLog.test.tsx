import { describe, expect, test } from 'bun:test'
import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectRaidLogPanel } from '../src/projects/ui/ProjectRaidLogPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const t = createTranslator('ja')

/**
 * Builds one stored entry.
 *
 * @param overrides - Fields replacing the open, high risk defaults.
 * @returns The entry.
 */
function entry(overrides: Partial<ProjectRaidEntry> = {}): ProjectRaidEntry {
  return {
    id: 'risk-1',
    kind: 'risk',
    title: 'ベンダー納期遅延',
    probability: 4,
    impact: 4,
    status: 'open',
    revision: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Renders the panel with no-op callbacks.
 *
 * @param entries - Entries to show.
 * @param canEdit - Whether the viewer may edit.
 * @returns The static markup.
 */
function render(entries: ProjectRaidEntry[] | undefined, canEdit = true) {
  return renderToStaticMarkup(
    <ProjectRaidLogPanel
      canEdit={canEdit}
      entries={entries}
      hasLoadError={false}
      isLoading={entries === undefined}
      t={t}
      today="2026-11-19"
      onReload={() => undefined}
      onSave={async () => undefined}
    />,
  )
}

describe('ProjectRaidLogPanel', () => {
  test('shows open counts, the highest severity, and overdue reviews', () => {
    const markup = render([
      entry({ reviewDueDate: '2026-11-10' }),
      entry({ id: 'issue-1', kind: 'issue', probability: undefined, impact: 2, title: 'ビルド失敗' }),
      entry({ id: 'cr-1', kind: 'change-request', probability: undefined, impact: 5, status: 'closed', title: '範囲追加' }),
    ])
    expect(markup).toContain('未解決のリスク 1件')
    expect(markup).toContain('未解決の課題 1件')
    expect(markup).toContain('未決の変更要求 0件')
    expect(markup).toContain('最高重大度: 高')
    expect(markup).toContain('見直し期限切れ 1件')
    expect(markup).toContain('期限切れです。内容を見直して期限を更新するか、クローズしてください。')
    expect(markup).toContain('ベンダー納期遅延')
    expect(markup).not.toContain('範囲追加')
  })

  test('hides editing for a reader and shows the loading state', () => {
    expect(render([entry()], false)).not.toContain('project-raid-log-add')
    expect(render([entry()], false)).toContain('プロジェクトのメンバーが登録・更新できます。')
    expect(render(undefined)).toContain('登録簿を読み込み中')
    expect(render([])).toContain('まだ登録はありません。')
  })
})

describe('ProjectRaidLogPanel entry details', () => {
  test('shows the description and response to readers', () => {
    const markup = render([entry({ description: '主要部品の納期が未確定', response: '代替ベンダーと交渉' })], false)
    expect(markup).toContain('主要部品の納期が未確定')
    expect(markup).toContain('代替ベンダーと交渉')
  })
})
