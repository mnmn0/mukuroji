import { describe, expect, test } from 'bun:test'
import type { DirectoryAdministrationTeam } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  listActiveDirectoryTeams,
  listArchivedDirectoryEntries,
  moveDirectoryId,
} from '../src/projects/model/directoryAdministration'
import { DirectoryAdministrationPanel } from '../src/projects/ui/DirectoryAdministrationPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const teams: DirectoryAdministrationTeam[] = [
  {
    id: 'core-team',
    nameJa: 'コアチーム',
    nameEn: 'Core Team',
    projects: [
      { id: 'refero', nameJa: 'Refero', nameEn: 'Refero', tone: 'blue' },
      {
        id: 'legacy',
        nameJa: '旧基盤',
        nameEn: 'Legacy',
        tone: 'green',
        archivedAt: '2026-06-06T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'sales',
    nameJa: '営業',
    nameEn: 'Sales',
    archivedAt: '2026-06-07T00:00:00.000Z',
    projects: [
      {
        id: 'crm',
        nameJa: 'CRM',
        nameEn: 'CRM',
        tone: 'yellow',
        archivedAt: '2026-06-07T00:00:00.000Z',
      },
    ],
  },
]

/** Resolves an action as successful, for rendering only. */
const succeed = async () => true

describe('directory administration model', () => {
  test('separates active rows from the archived rows that can be restored now', () => {
    expect(listActiveDirectoryTeams(teams).map((team) => ({
      id: team.id,
      projects: team.projects.map((project) => project.id),
    }))).toEqual([{ id: 'core-team', projects: ['refero'] }])
    expect(listArchivedDirectoryEntries(teams).map((entry) =>
      entry.kind === 'team' ? `team:${entry.team.id}` : `project:${entry.project.id}`
    )).toEqual(['project:legacy', 'team:sales'])
  })

  test('moves one ID by one place and refuses to move past either end', () => {
    expect(moveDirectoryId(['a', 'b', 'c'], 'c', 'up')).toEqual(['a', 'c', 'b'])
    expect(moveDirectoryId(['a', 'b', 'c'], 'a', 'down')).toEqual(['b', 'a', 'c'])
    expect(moveDirectoryId(['a', 'b', 'c'], 'a', 'up')).toBeUndefined()
    expect(moveDirectoryId(['a', 'b', 'c'], 'c', 'down')).toBeUndefined()
    expect(moveDirectoryId(['a'], 'missing', 'up')).toBeUndefined()
  })
})

describe('DirectoryAdministrationPanel', () => {
  test('lists active rows with their IDs and offers restore for archived rows', () => {
    const markup = renderToStaticMarkup(
      <DirectoryAdministrationPanel
        onMoveProject={succeed}
        onMoveTeam={succeed}
        onRenameProject={succeed}
        onRenameTeam={succeed}
        onRestoreProject={succeed}
        onRestoreTeam={succeed}
        t={createTranslator('ja')}
        teams={teams}
      />,
    )

    expect(markup).toContain('チームとプロジェクトの管理')
    expect(markup).toContain('Core Team · core-team')
    expect(markup).toContain('aria-label="コアチーム の名前を変更"')
    expect(markup).toContain('aria-label="旧基盤 を復元"')
    expect(markup).toContain('aria-label="営業 を復元"')
    expect(markup).not.toContain('aria-label="CRM を復元"')
  })
})
