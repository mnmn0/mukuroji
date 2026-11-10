import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FactoryBoardItem } from '@mukuroji/contracts'
import { factoryBoardFixtureNow, factoryBoardFixtureProjectNames, factoryLineFixture } from '../src/features/factory-board/fixtures'
import { defaultFactoryBoardFilters } from '../src/features/factory-board/model/factoryBoard'
import {
  FACTORY_LINE_ALL_STATIONS,
  classifyFactoryLineStation,
  groupFactoryLineItems,
  readFactoryLineNameTag,
  readNextFactoryLineStation,
} from '../src/features/factory-board/model/factoryLine'
import { FactoryLineScene } from '../src/features/factory-board/ui/FactoryLineScene'
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

  test('shortens worker names to fit a tag', () => {
    expect(readFactoryLineNameTag({ assigneeUserId: 'u1', assigneeName: '鈴木 一郎', assigneeEmail: 'suzuki@example.com' })).toBe('鈴木 一郎')
    expect(readFactoryLineNameTag({ assigneeUserId: 'u1', assigneeEmail: 'tanaka@example.com' })).toBe('tanaka')
    expect(readFactoryLineNameTag({ assigneeUserId: 'u1', assigneeName: 'Alexandria Ocasio' })).toBe('Alexandri…')
    // Only an email is cut at the @; a display name or member ID keeps it.
    expect(readFactoryLineNameTag({ assigneeUserId: 'u1', assigneeName: 'Agent@Ops' })).toBe('Agent@Ops')
    expect(readFactoryLineNameTag({ assigneeUserId: 'member@local' })).toBe('member@lo…')
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

  test('says nothing matches instead of drawing an empty line when the filters leave no task', () => {
    const labels = createFactoryBoardLabels('ja')
    const markup = renderToStaticMarkup(
      <FactoryBoard
        board={factoryLineFixture}
        formatDateTime={(value) => value}
        getWorkItemHref={(entry) => `/teams/core/issues?issueId=${entry.workItem.id}`}
        initialFilters={{ ...defaultFactoryBoardFilters, assigneeUserId: 'nobody' }}
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
    expect(markup).toContain(labels.noResults)
    expect(markup).not.toContain(labels.line.sceneLabel)
  })
})

describe('Factory line scene', () => {
  const labels = createFactoryBoardLabels('ja').line

  /**
   * Draws the scene and returns its tags' text.
   *
   * @param focusedStation - Station the camera follows, or undefined for the whole line.
   * @param items - Items to place; the line fixture by default.
   * @returns Text of every tag drawn above workers or parcels.
   */
  function readTags(focusedStation?: 'build' | 'done', items: readonly FactoryBoardItem[] = factoryLineFixture.items): string[] {
    const markup = renderToStaticMarkup(
      <FactoryLineScene
        groups={groupFactoryLineItems(items, now)}
        idPrefix="test"
        labels={labels}
        onFocusStation={() => undefined}
        {...(focusedStation === undefined ? {} : { focusedStation })}
      />,
    )
    return [...markup.matchAll(/data-factory-line-tag=""[^>]*>.*?<text[^>]*>([^<]*)<\/text>/gu)].map((match) => match[1] ?? '')
  }

  test('names the workers of the station the camera follows', () => {
    expect(readTags('build')).toEqual(['鈴木 一郎', 'tanaka@ex…', 'tanaka@ex…'])
    // Finished tasks have no worker; their names sit on the parcels.
    expect(readTags('done')).toEqual(['佐藤 花子'])
  })

  test('draws no tags on the whole line', () => {
    expect(readTags()).toEqual([])
  })

  test('lays the name tags of a station out in one row without overlaps', () => {
    const finished = item('docs-link')
    const many = Array.from({ length: 3 }, (_, index): FactoryBoardItem => ({ ...finished, workItem: { ...finished.workItem, id: `done-${index}` } }))
    const cases: Array<{ /** Station the camera follows. */ station: 'done' | 'build'; /** Items to place. */ items: readonly FactoryBoardItem[] }> = [
      { station: 'done', items: many },
      { station: 'build', items: factoryLineFixture.items },
    ]
    for (const { station, items } of cases) {
      const markup = renderToStaticMarkup(
        <FactoryLineScene focusedStation={station} groups={groupFactoryLineItems(items, now)} idPrefix="test" labels={labels} onFocusStation={() => undefined} />,
      )
      const tags = [...markup.matchAll(/data-factory-line-tag="" transform="translate\(([-\d.]+) ([-\d.]+)\)"><rect height="15" rx="4" style="[^"]*" stroke-width="1" width="([\d.]+)"/gu)]
        .map((match) => ({ left: Number(match[1]), top: Number(match[2]), width: Number(match[3]) }))
      expect(tags).toHaveLength(3)
      // Every tag sits in the same row, and each starts past the right edge of the one before it.
      expect(new Set(tags.map((tag) => tag.top)).size).toBe(1)
      for (let index = 1; index < tags.length; index += 1) {
        const previous = tags[index - 1]
        expect(tags[index]?.left ?? 0).toBeGreaterThanOrEqual((previous?.left ?? 0) + (previous?.width ?? 0))
      }
    }
  })

  test('counts the tasks a station does not draw', () => {
    const building = item('refund-ids')
    const many = Array.from({ length: 5 }, (_, index): FactoryBoardItem => ({ ...building, workItem: { ...building.workItem, id: `many-${index}` } }))
    expect(readTags('build', many)).toEqual(['鈴木 一郎', '鈴木 一郎', '鈴木 一郎', 'ほか 2 件'])
  })
})
