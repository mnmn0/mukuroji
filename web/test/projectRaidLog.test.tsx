import { describe, expect, test } from 'bun:test'
import type { ProjectRaidEntry } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectRaidLogPanel } from '../src/projects/ui/ProjectRaidLogPanel'
import { createProjectRaidLogCsv } from '../src/projects/model/projectRaidLogExport'
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

describe('ProjectRaidLogPanel owner and related Work Items', () => {
  test('names the owner and related Work Items, falling back to the stored ID', () => {
    const markup = renderToStaticMarkup(
      <ProjectRaidLogPanel
        canEdit={false}
        entries={[entry({ ownerMemberId: 'member-1', relatedWorkItemIds: ['item-1', 'item-gone'] })]}
        hasLoadError={false}
        isLoading={false}
        ownerOptions={[{ id: 'member-1', label: '佐藤' }]}
        t={t}
        today="2026-11-19"
        workItemOptions={[{ id: 'item-1', label: 'CT-1 設計レビュー' }]}
        onReload={() => undefined}
        onSave={async () => undefined}
      />,
    )
    expect(markup).toContain('担当: 佐藤')
    expect(markup).toContain('関連: CT-1 設計レビュー / item-gone')
    expect(markup).toContain('CSV を書き出す')
  })
})

describe('ProjectRaidLogPanel Work Item candidates', () => {
  test('explains a failed candidate load and offers a retry', () => {
    const markup = renderToStaticMarkup(
      <ProjectRaidLogPanel
        canEdit
        entries={[entry()]}
        hasLoadError={false}
        hasWorkItemOptionsError
        isLoading={false}
        t={t}
        today="2026-11-19"
        onReload={() => undefined}
        onReloadWorkItemOptions={() => undefined}
        onSave={async () => undefined}
      />,
    )
    expect(markup).toContain('関連 Work Item の候補を読み込めませんでした。')
    expect(markup).toContain('data-testid="project-raid-log-work-items-error"')
    expect(markup).toContain('再読み込み')
    expect(render([entry()])).not.toContain('project-raid-log-work-items-error')
  })
})

describe('createProjectRaidLogCsv', () => {
  test('writes one row per entry with labels and escapes formulas', () => {
    const csv = createProjectRaidLogCsv(
      [entry({ title: '=HYPERLINK("x")', ownerMemberId: 'member-1', relatedWorkItemIds: ['item-1'], reviewDueDate: '2026-12-01' })],
      {
        headers: {
          kind: '種類', title: 'タイトル', status: '状態', severity: '重大度', probability: '確率', impact: '影響',
          owner: '担当者', reviewDueDate: '見直し期限', relatedWorkItems: '関連', description: '内容', response: '対応',
          createdAt: '登録', updatedAt: '更新', closedAt: 'クローズ',
        },
        kind: () => 'リスク',
        status: () => '未解決',
        severity: (severity) => severity,
      },
      [{ id: 'member-1', label: '佐藤' }],
      [{ id: 'item-1', label: 'CT-1 設計' }],
    )
    const [header, row] = csv.split('\r\n')
    expect(header).toBe('"種類","タイトル","状態","重大度","確率","影響","担当者","見直し期限","関連","内容","対応","登録","更新","クローズ"')
    expect(row).toBe(`"リスク","'=HYPERLINK(""x"")","未解決","high","4","4","佐藤","2026-12-01","CT-1 設計","","","2026-11-19T00:00:00.000Z","2026-11-19T00:00:00.000Z",""`)
  })
})
