import { classifyFactoryBoardItem, type FactoryBoardItem } from '@mukuroji/contracts'
import { groupFactoryBoardItems } from './factoryBoard'

/** Stations of the line in the order work moves through them. */
export const FACTORY_LINE_STATIONS = ['intake', 'build', 'verify', 'artifact', 'decision', 'done'] as const

/** Station on the main line. */
export type FactoryLineMainStation = (typeof FACTORY_LINE_STATIONS)[number]

/** Station of one item: a main-line station, or the repair bay beside the line for failed runs. */
export type FactoryLineStation = FactoryLineMainStation | 'repair'

/** Every station the line shows, main line first and the repair bay last. */
export const FACTORY_LINE_ALL_STATIONS: readonly FactoryLineStation[] = [...FACTORY_LINE_STATIONS, 'repair']

/** One item placed on the line. */
export type FactoryLineEntry = {
  /** Board item. */
  item: FactoryBoardItem
  /** Whether the item's run is active with an expired lease; the worker stops at its station. */
  stalled: boolean
}

/** One station with the items at it, in the board's lane order. */
export type FactoryLineStationGroup = {
  /** Station. */
  station: FactoryLineStation
  /** Items at the station. */
  entries: FactoryLineEntry[]
}

/**
 * Places a board item at its station at a given time. The lane comes from the shared contract rule,
 * so the line and the lanes always agree; active runs then move along the line by their latest report.
 *
 * @param item - Board item.
 * @param now - Time the item is evaluated at, normally the board's read time.
 * @returns The station, or undefined when the item belongs to no lane.
 */
export function classifyFactoryLineStation(item: FactoryBoardItem, now: Date): FactoryLineStation | undefined {
  const lane = classifyFactoryBoardItem(item, now)
  switch (lane) {
    case undefined:
      return undefined
    case 'no-run':
      return 'intake'
    case 'decision':
      return 'decision'
    case 'failed':
      return 'repair'
    case 'completed':
      return 'done'
    case 'processing':
    case 'stalled': {
      // A report of an earlier run says nothing about where the active run is.
      const kind = item.latestReport?.runId === item.run?.runId ? item.latestReport?.kind : undefined
      if (kind === 'verification') return 'verify'
      if (kind === 'artifact') return 'artifact'
      return 'build'
    }
  }
}

/**
 * Places items at their stations at a given time, keeping the board's order within each lane.
 *
 * @param items - Board items.
 * @param now - Time the items are evaluated at.
 * @returns Every station in display order, including empty ones.
 */
export function groupFactoryLineItems(items: readonly FactoryBoardItem[], now: Date): FactoryLineStationGroup[] {
  const groups = new Map<FactoryLineStation, FactoryLineEntry[]>(FACTORY_LINE_ALL_STATIONS.map((station) => [station, []]))
  for (const { lane, items: laneItems } of groupFactoryBoardItems(items, now)) {
    for (const item of laneItems) {
      const station = classifyFactoryLineStation(item, now)
      if (station !== undefined) groups.get(station)?.push({ item, stalled: lane === 'stalled' })
    }
  }
  return FACTORY_LINE_ALL_STATIONS.map((station) => ({ station, entries: groups.get(station) ?? [] }))
}

/**
 * Reads the station shown after another one in the step bar, wrapping from the last to the first.
 *
 * @param station - Current station, or undefined for the whole line.
 * @returns Next station.
 */
export function readNextFactoryLineStation(station: FactoryLineStation | undefined): FactoryLineStation {
  const index = station === undefined ? -1 : FACTORY_LINE_ALL_STATIONS.indexOf(station)
  return FACTORY_LINE_ALL_STATIONS[(index + 1) % FACTORY_LINE_ALL_STATIONS.length] ?? 'intake'
}
