import { useEffect, useState, useSyncExternalStore } from 'react'
import { readNextFactoryLineStation, type FactoryLineStation, type FactoryLineStationGroup } from '../model/factoryLine'
import type { FactoryLineLabels } from './factoryBoardLabels'
import { FactoryLineScene } from './FactoryLineScene'

/** Seconds each station stays in view while the line plays. */
const playIntervalMs = 4_000

/** Media query of people who asked for less motion. */
const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

/**
 * Subscribes to the reduced-motion preference.
 *
 * @param onChange - Called when the preference changes.
 * @returns Unsubscribe function.
 */
function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Reads whether motion should be reduced.
 *
 * @returns True when the person asked for less motion.
 */
function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(reducedMotionQuery).matches
}

/** Props of the line view. */
export type FactoryLineProps = {
  /** Stations with their tasks, in display order. */
  groups: readonly FactoryLineStationGroup[]
  /** Station the camera follows; the whole line when absent. */
  focusedStation?: FactoryLineStation
  /** Chooses a station, or the whole line. */
  onFocusStation: (station: FactoryLineStation | undefined) => void
  /** Selected task, highlighted on the line. */
  selectedWorkItemId?: string
  /** Locale-aware text. */
  labels: FactoryLineLabels
  /** Unique prefix for SVG IDs. */
  idPrefix: string
}

/**
 * Shows the factory line with a station bar under it. Choosing a station moves the camera there;
 * playing goes through the stations every few seconds. Playing is not offered when the person asked
 * for less motion, and choosing a station by hand stops it.
 *
 * @param props - Stations, focus, selection, and text.
 * @returns Line view.
 */
export function FactoryLine({ groups, focusedStation, onFocusStation, selectedWorkItemId, labels, idPrefix }: FactoryLineProps) {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false)
  const [playing, setPlaying] = useState(false)
  const isPlaying = playing && !reducedMotion

  useEffect(() => {
    if (!isPlaying) return undefined
    const timer = window.setTimeout(() => onFocusStation(readNextFactoryLineStation(focusedStation)), playIntervalMs)
    return () => window.clearTimeout(timer)
  }, [focusedStation, isPlaying, onFocusStation])

  /**
   * Chooses a station by hand, which stops playing.
   *
   * @param station - Station, or undefined for the whole line.
   */
  const choose = (station: FactoryLineStation | undefined) => {
    setPlaying(false)
    onFocusStation(station)
  }

  return (
    <div className="grid min-w-0 gap-2" data-testid="factory-line">
      <div className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-canvas)]">
        <FactoryLineScene
          focusedStation={focusedStation}
          groups={groups}
          idPrefix={idPrefix}
          labels={labels}
          onFocusStation={choose}
          {...(selectedWorkItemId === undefined ? {} : { selectedWorkItemId })}
        />
      </div>
      <div aria-label={labels.stepBar} className="flex min-w-0 flex-wrap items-center gap-1.5" role="group">
        {reducedMotion ? null : (
          <button
            aria-pressed={isPlaying}
            className="workbench-button-primary min-h-[44px] px-3 text-xs"
            onClick={() => {
              if (isPlaying) {
                setPlaying(false)
                return
              }
              setPlaying(true)
              onFocusStation(readNextFactoryLineStation(focusedStation))
            }}
            type="button"
          >
            {isPlaying ? labels.pause : labels.play}
          </button>
        )}
        {groups.map((group, index) => (
          <StationButton
            count={group.entries.length}
            key={group.station}
            label={labels.stations[group.station]}
            {...(group.station === 'repair' ? {} : { number: index + 1 })}
            onClick={() => choose(group.station)}
            pressed={group.station === focusedStation}
          />
        ))}
        <StationButton label={labels.overview} onClick={() => choose(undefined)} pressed={focusedStation === undefined} />
      </div>
    </div>
  )
}

/**
 * Shows one station choice with its number and task count.
 *
 * @param props - Text, count, and state.
 * @param props.label - Station name.
 * @param props.number - Station number on the main line.
 * @param props.count - Tasks at the station.
 * @param props.pressed - Whether the camera follows the station.
 * @param props.onClick - Chooses the station.
 * @returns Button.
 */
function StationButton({ label, number, count, pressed, onClick }: { label: string; number?: number; count?: number; pressed: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={pressed}
      className={`flex min-h-[44px] items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors ${pressed ? 'border-[var(--workbench-primary)] bg-[var(--workbench-primary-surface)] text-[var(--workbench-primary-text)]' : 'border-[var(--workbench-border)] bg-[var(--workbench-surface)] text-[var(--workbench-text)] hover:border-[var(--workbench-border-strong)]'}`}
      onClick={onClick}
      type="button"
    >
      {number === undefined ? null : <span className="tabular-nums text-[var(--workbench-muted)]">{String(number).padStart(2, '0')}</span>}
      <span>{label}</span>
      {count === undefined ? null : <span className="tabular-nums text-[var(--workbench-muted)]">{count}</span>}
    </button>
  )
}
