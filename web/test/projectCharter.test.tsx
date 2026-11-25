import { describe, expect, test } from 'bun:test'
import type { ProjectCharterState } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectDirectoryTeam } from '../src/projects/api/directory'
import {
  createProjectCharterDraftStore,
  createProjectCharterFormValues,
  createProjectCharterPersonCandidates,
  createProjectCharterUpdateInput,
  newerProjectCharterState,
} from '../src/projects/model/projectCharterView'
import {
  createProjectDirectoryRows,
  filterProjectDirectoryRows,
  parseProjectDirectoryLifecycleFilter,
} from '../src/projects/model/projectDirectoryView'
import { ProjectCharterPanel } from '../src/projects/ui/ProjectCharterPanel'
import { ProjectDirectoryView } from '../src/projects/ui/ProjectDirectoryView'
import { createTranslator } from '../src/shared/i18n/i18n'

const teams: ProjectDirectoryTeam[] = [{
  id: 'core-team',
  name: 'Core Team',
  projects: [
    {
      id: 'refero',
      name: 'Refero',
      tone: 'blue',
      lifecycleState: 'on-hold',
      charter: {
        code: 'OPS-1',
        owner: { userId: 'sato@example.com', displayName: '佐藤 花子' },
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2027-03-31',
      },
    },
    { id: 'legacy', name: 'Legacy', tone: 'green' },
  ],
}]
const emptySummary = { buckets: [], generatedAt: '2026-06-10T00:00:00.000Z' }
const rows = createProjectDirectoryRows(teams, emptySummary)

describe('Project directory charter columns', () => {
  test('reads lifecycle and charter summary, defaulting legacy Projects to active', () => {
    expect(rows.map((row) => ({
      projectId: row.projectId,
      lifecycleState: row.lifecycleState,
      code: row.code,
      owner: row.owner?.displayName,
      plannedEndDate: row.plannedEndDate,
    }))).toEqual([
      {
        projectId: 'refero',
        lifecycleState: 'on-hold',
        code: 'OPS-1',
        owner: '佐藤 花子',
        plannedEndDate: '2027-03-31',
      },
      {
        projectId: 'legacy',
        lifecycleState: 'active',
        code: undefined,
        owner: undefined,
        plannedEndDate: undefined,
      },
    ])
  })

  test('filters by lifecycle and searches by code and owner', () => {
    const base = { query: '', quickAccessOnly: false, status: 'all' as const }
    expect(filterProjectDirectoryRows(rows, { ...base, lifecycle: 'active' }).map((row) => row.projectId))
      .toEqual(['legacy'])
    expect(filterProjectDirectoryRows(rows, { ...base, query: 'ops-1' }).map((row) => row.projectId))
      .toEqual(['refero'])
    expect(filterProjectDirectoryRows(rows, { ...base, query: '佐藤' }).map((row) => row.projectId))
      .toEqual(['refero'])
    expect(parseProjectDirectoryLifecycleFilter('closed')).toBe('closed')
    expect(parseProjectDirectoryLifecycleFilter('done')).toBeUndefined()
    // The directory lists only unarchived Projects, so an archived deep link shows everything.
    expect(parseProjectDirectoryLifecycleFilter('archived')).toBeUndefined()
  })

  test('renders the lifecycle badge, code, owner, and planned period', () => {
    const html = renderToStaticMarkup(
      <ProjectDirectoryView
        assignees={[]}
        filteredCount={rows.length}
        filters={{ query: '', quickAccessOnly: false, status: 'all' }}
        hasUnassignedProjects
        page={1}
        pageCount={1}
        rows={rows}
        t={createTranslator('ja')}
        teams={teams}
        totalCount={rows.length}
        onAssigneeChange={() => undefined}
        onClearFilters={() => undefined}
        onOpenProject={() => undefined}
        onPageChange={() => undefined}
        onQuickAccessOnlyChange={() => undefined}
        onSearchChange={() => undefined}
        onStatusChange={() => undefined}
        onLifecycleChange={() => undefined}
        onTeamChange={() => undefined}
        onToggleQuickAccess={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="project-lifecycle-core-team-refero"')
    expect(html).toContain('保留')
    expect(html).toContain('OPS-1')
    expect(html).toContain('佐藤 花子')
    expect(html).toContain('2026-04-01 – 2027-03-31')
    expect(html).toContain('責任者未設定')
    expect(html).toContain('data-testid="project-directory-lifecycle-filter"')
  })
})

/**
 * Creates a charter state fixture.
 *
 * @param overrides - Fields replacing the defaults.
 * @returns A charter state.
 */
function createState(overrides: Partial<ProjectCharterState> = {}): ProjectCharterState {
  return {
    teamId: 'core-team',
    projectId: 'refero',
    lifecycleState: 'active',
    charter: { tags: [], repositoryUrls: [] },
    revision: 2,
    ...overrides,
  }
}

/**
 * Renders the charter panel to static markup.
 *
 * @param state - Charter state.
 * @param permissions - Editing permissions.
 * @returns Rendered HTML.
 */
function renderPanel(
  state: ProjectCharterState,
  permissions: { canEdit: boolean; canDecideProposal: boolean },
) {
  return renderToStaticMarkup(
    <ProjectCharterPanel
      {...permissions}
      members={[{ id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子', role: 'manager' }]}
      state={state}
      t={createTranslator('ja')}
      onReload={() => undefined}
      onSave={async () => undefined}
      onTransition={async () => undefined}
    />,
  )
}

describe('ProjectCharterPanel', () => {
  test('offers the allowed lifecycle transitions to an editor', () => {
    const html = renderPanel(createState(), { canEdit: true, canDecideProposal: false })

    expect(html).toContain('data-testid="project-lifecycle-on-hold"')
    expect(html).toContain('data-testid="project-lifecycle-closed"')
    expect(html).not.toContain('data-testid="project-lifecycle-proposed"')
    expect(html).toContain('data-testid="project-charter-save"')
  })

  test('leaves proposal decisions to Workspace administrators', () => {
    const html = renderPanel(
      createState({ lifecycleState: 'proposed' }),
      { canEdit: true, canDecideProposal: false },
    )

    expect(html).toContain('提案中のプロジェクトの承認や却下は Workspace 管理者が行います。')
    expect(html).toMatch(/data-testid="project-lifecycle-approved"[^>]*disabled=""|disabled=""[^>]*data-testid="project-lifecycle-approved"/u)
  })

  test('shows a read-only charter and the closed notice', () => {
    const html = renderPanel(
      createState({
        lifecycleState: 'closed',
        charter: {
          code: 'OPS-1',
          owner: { userId: 'former@example.com', displayName: '元 PM' },
          tags: [],
          repositoryUrls: [],
        },
      }),
      { canEdit: false, canDecideProposal: false },
    )

    expect(html).toContain('このプロジェクトは終結しています。新しい Issue は作成できません。')
    expect(html).toContain('憲章を編集できるのはプロジェクトマネージャーと Workspace 管理者です。')
    expect(html).toContain('元 PM')
    expect(html).not.toContain('data-testid="project-charter-save"')
    expect(html).not.toContain('data-testid="project-lifecycle-active"')
  })

  test('builds a complete replacement from the form values', () => {
    expect(createProjectCharterUpdateInput({
      code: ' ops-1 ',
      purpose: '',
      description: '説明',
      ownerUserId: 'sato@example.com',
      sponsorUserId: '',
      plannedStartDate: '2026-04-01',
      plannedEndDate: '',
      tags: '基盤, 刷新、 ,社内',
      repositoryUrls: 'https://github.com/example/a\n\nhttps://github.com/example/b',
    }, 2)).toEqual({
      expectedRevision: 2,
      charter: {
        code: 'ops-1',
        description: '説明',
        ownerUserId: 'sato@example.com',
        plannedStartDate: '2026-04-01',
        tags: ['基盤', '刷新', '社内'],
        repositoryUrls: ['https://github.com/example/a', 'https://github.com/example/b'],
      },
    })
  })

  test('keeps every stored tag when the form is saved unchanged', () => {
    const charter = { tags: ['研究開発', 'R&D', '社内 基盤'], repositoryUrls: [] }
    expect(createProjectCharterUpdateInput(createProjectCharterFormValues(charter), 1).charter.tags)
      .toEqual(charter.tags)
  })

  test('restores a draft kept for the same Team and Project only', () => {
    const store = createProjectCharterDraftStore()
    const owner = {}
    store.claim('core-team', 'refero', owner)
    const values = { ...createProjectCharterFormValues({ tags: [], repositoryUrls: [] }), purpose: '下書きの目的' }
    store.write('core-team', 'refero', { revision: 2, values }, owner)

    expect(store.read('core-team', 'refero')).toEqual({ revision: 2, values })
    expect(store.read('other-team', 'refero')).toBeUndefined()
    const html = renderToStaticMarkup(
      <ProjectCharterPanel
        canDecideProposal={false}
        canEdit
        initialDraft={store.read('core-team', 'refero')}
        members={[]}
        state={createState()}
        t={createTranslator('ja')}
        onReload={() => undefined}
        onSave={async () => undefined}
        onTransition={async () => undefined}
      />,
    )
    expect(html).toContain('下書きの目的')

    store.write('core-team', 'refero', undefined, owner)
    expect(store.read('core-team', 'refero')).toBeUndefined()
  })

  test('ignores a replaced panel whose save completes after the Project was shown again', () => {
    const store = createProjectCharterDraftStore()
    const values = createProjectCharterFormValues({ tags: [], repositoryUrls: [] })
    const first = {}
    store.claim('core-team', 'refero', first)
    const submitted = { revision: 1, values: { ...values, purpose: '保存中' } }
    store.write('core-team', 'refero', submitted, first)

    // The Project is shown again and restores the same draft before the first save completes.
    const second = {}
    store.claim('core-team', 'refero', second)
    store.write('core-team', 'refero', undefined, first)
    expect(store.read('core-team', 'refero')).toBe(submitted)

    const newer = { revision: 1, values: { ...values, purpose: '戻って編集' } }
    store.write('core-team', 'refero', newer, second)
    store.write('core-team', 'refero', undefined, first)
    expect(store.read('core-team', 'refero')).toBe(newer)
  })

  test('lets a panel that was not replaced clear the draft its save committed', () => {
    const store = createProjectCharterDraftStore()
    const owner = {}
    store.claim('core-team', 'refero', owner)
    store.write('core-team', 'refero', {
      revision: 1,
      values: createProjectCharterFormValues({ tags: [], repositoryUrls: [] }),
    }, owner)

    store.write('core-team', 'refero', undefined, owner)

    expect(store.read('core-team', 'refero')).toBeUndefined()
  })

  test('offers active Workspace members, not only Project members, as owner and sponsor', () => {
    expect(createProjectCharterPersonCandidates([
      { memberKey: 'suzuki@example.com', email: 'suzuki@example.com', name: '鈴木 次郎', status: 'active' },
      { memberKey: 'gone@example.com', email: 'gone@example.com', name: '退職者', status: 'suspended' },
      { memberKey: 'ext@example.com', email: 'ext@example.com', status: 'active' },
    ])).toEqual([
      { id: 'ext@example.com', email: 'ext@example.com' },
      { id: 'suzuki@example.com', email: 'suzuki@example.com', name: '鈴木 次郎' },
    ])
  })
})

describe('newerProjectCharterState', () => {
  test('keeps a newer cached charter when an older save response arrives late', () => {
    const older = createState({ revision: 2 })
    const newer = createState({ revision: 3 })

    expect(newerProjectCharterState(newer, older)).toBe(newer)
    expect(newerProjectCharterState(older, newer)).toBe(newer)
    expect(newerProjectCharterState(undefined, older)).toBe(older)
  })
})
