import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FactoryBoardItem } from '@mukuroji/contracts'
import { factoryBoardFixtureNow, factoryBoardFixtureProjectNames, factoryLineFixture } from '../src/features/factory-board/fixtures'
import {
  FACTORY_LINE_ALL_STATIONS,
  classifyFactoryLineStation,
  groupFactoryLineItems,
  readNextFactoryLineStation,
} from '../src/features/factory-board/model/factoryLine'
import { FactoryBoard } from '../src/features/factory-board/ui/FactoryBoard'
import { createFactoryBoardLabels } from '../src/features/factory-board/ui/factoryBoardLabels'

const now = new Date(factoryBoardFixtureNow)

/**
 * Finds a fixture item by Work Item ID.
 *
 * @param id - Work Item ID.
 * @returns Fixture item.
 */
function item(id: string): FactoryBoardItem {
  const found = factoryLineFixture.items.find((candidate) => candidate.workItem.id === id)
  if (!found) throw new Error(`Missing fixture ${id}`)
  return found
}

describe('Factory line stations', () => {
  test('moves active runs along the line by their latest report', () => {
    expect(classifyFactoryLineStation(item('refund-ids'), now)).toBe('build')
    expect(classifyFactoryLineStation(item('release-notes'), now)).toBe('build')
    expect(classifyFactoryLineStation(item('audit-export'), now)).toBe('verify')
    expect(classifyFactoryLineStation(item('onboarding-copy'), now)).toBe('artifact')
  })

  test('places the other lanes at their stations', () => {
    expect(classifyFactoryLineStation(item('manual-start'), now)).toBe('intake')
    expect(classifyFactoryLineStation(item('schema-change'), now)).toBe('decision')
    expect(classifyFactoryLineStation(item('review-wait'), now)).toBe('decision')
    expect(classifyFactoryLineStation(item('flaky-test'), now)).toBe('repair')
    expect(classifyFactoryLineStation(item('docs-link'), now)).toBe('done')
    // A stalled run stays at its station and is marked instead.
    expect(classifyFactoryLineStation(item('stalled-import'), now)).toBe('build')
  })

  test('ignores a report of an earlier run when placing the active one', () => {
    const verified = item('audit-export')
    if (!verified.run) throw new Error('The fixture has a run')
    const restarted: FactoryBoardItem = { ...verified, run: { ...verified.run, runId: 'run_00000000-0000-4000-8000-000000000099' } }
    expect(classifyFactoryLineStation(restarted, now)).toBe('build')
  })

  test('groups every station, marks stalled runs, and drops items outside any lane', () => {
    const closed: FactoryBoardItem = { workItem: { ...item('manual-start').workItem, id: 'closed', statusCategory: 'completed' } }
    const groups = groupFactoryLineItems([...factoryLineFixture.items, closed], now)
    expect(groups.map((group) => group.station)).toEqual([...FACTORY_LINE_ALL_STATIONS])
    const build = groups.find((group) => group.station === 'build')
    expect(build?.entries.find((entry) => entry.item.workItem.id === 'stalled-import')?.stalled).toBe(true)
    expect(build?.entries.find((entry) => entry.item.workItem.id === 'refund-ids')?.stalled).toBe(false)
    expect(groups.flatMap((group) => group.entries).some((entry) => entry.item.workItem.id === 'closed')).toBe(false)
  })

  test('plays through every station and wraps around', () => {
    expect(readNextFactoryLineStation(undefined)).toBe('intake')
    expect(readNextFactoryLineStation('done')).toBe('repair')
    expect(readNextFactoryLineStation('repair')).toBe('intake')
  })
})

describe('Factory line view', () => {
  test('draws the line with a described scene, a station bar, and the chosen station panel', () => {
    const labels = createFactoryBoardLabels('ja')
    const markup = renderToStaticMarkup(
      <FactoryBoard
        board={factoryLineFixture}
        formatDateTime={(value) => value}
        getWorkItemHref={(entry) => `/teams/core/issues?issueId=${entry.workItem.id}`}
        initialFocusedStation="build"
        isLoading={false}
        labels={labels}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onSelect={() => undefined}
        onViewChange={() => undefined}
        projectNames={factoryBoardFixtureProjectNames}
        reports={{ isLoading: false }}
        view="line"
      />,
    )
    expect(markup).toContain('role="img"')
    expect(markup).toContain(labels.line.sceneLabel)
    expect(markup).toContain('実装 3 件')
    expect(markup).toContain(labels.line.stationDescriptions.build)
    expect(markup).toContain('返金一覧に取引 ID の検索を足す')
    expect(markup).toContain(labels.line.stalled)
    // The lanes are not drawn in the line view.
    expect(markup).not.toContain('data-factory-board-item')
  })
})
