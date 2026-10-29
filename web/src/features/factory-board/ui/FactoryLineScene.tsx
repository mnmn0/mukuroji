import type { AgentRunRuntime } from '@mukuroji/contracts'
import type { ReactNode } from 'react'
import type { FactoryLineEntry, FactoryLineStation, FactoryLineStationGroup } from '../model/factoryLine'
import type { FactoryLineLabels } from './factoryBoardLabels'

/** Screen pixels of one world unit. */
const unit = 22

/** Horizontal screen pixels per world unit along an isometric axis. */
const isoX = Math.cos(Math.PI / 6) * unit

/** Vertical screen pixels per world unit along an isometric axis. */
const isoY = Math.sin(Math.PI / 6) * unit

/** Distance in world units between neighboring stations on the main line. */
const stationSpacing = 7

/** Boxes and workers drawn per station; the rest is counted on the station sign. */
const drawnPerStation = 3

/** Visible part of the scene in SVG user units. */
const viewBox = { x: -250, y: -215, width: 1180, height: 800 }

/** Zoom applied when the camera follows one station. */
const stationZoom = 1.9

/** World position of each station's machine. */
const stationPositions: Record<FactoryLineStation, { /** World x. */ x: number; /** World y. */ y: number }> = {
  intake: { x: 0, y: 0 },
  build: { x: stationSpacing, y: 0 },
  verify: { x: stationSpacing * 2, y: 0 },
  artifact: { x: stationSpacing * 3, y: 0 },
  decision: { x: stationSpacing * 4, y: 0 },
  done: { x: stationSpacing * 5, y: 0 },
  repair: { x: stationSpacing * 3 + 4, y: 11.5 },
}

/** Robot body color of each runtime; the runtime name is always written beside the robot in the panel. */
const runtimeColors: Record<AgentRunRuntime, string> = {
  'claude-code': '#d97757',
  codex: '#4b5563',
  kiro: '#7c3aed',
  other: '#2563eb',
}

/** Surface colors of the scene, mixed from the theme so light and dark themes both read. */
const colors = {
  floor: 'color-mix(in srgb, var(--workbench-surface-muted) 92%, var(--workbench-text) 4%)',
  floorLine: 'color-mix(in srgb, var(--workbench-border) 70%, transparent)',
  top: 'var(--workbench-surface)',
  left: 'color-mix(in srgb, var(--workbench-surface) 86%, var(--workbench-text) 14%)',
  right: 'color-mix(in srgb, var(--workbench-surface) 74%, var(--workbench-text) 26%)',
  accent: 'var(--workbench-primary)',
  accentSoft: 'color-mix(in srgb, var(--workbench-primary) 30%, var(--workbench-surface))',
  belt: 'color-mix(in srgb, var(--workbench-text) 72%, var(--workbench-surface))',
  beltStripe: 'color-mix(in srgb, var(--workbench-surface) 40%, transparent)',
  box: '#d9a35b',
  boxSide: '#b9833f',
  boxTape: '#f3d9a8',
  text: 'var(--workbench-text)',
  muted: 'var(--workbench-muted)',
  warning: 'var(--workbench-warning)',
  danger: 'var(--workbench-danger)',
  success: 'var(--workbench-success)',
  skin: '#f1c7a5',
  hair: '#3b2f2a',
  person: '#4f46e5',
} as const

/**
 * Projects a world point to screen coordinates.
 *
 * @param x - World x, along the line.
 * @param y - World y, across the line.
 * @param z - Height.
 * @returns Screen point.
 */
function project(x: number, y: number, z = 0): readonly [number, number] {
  return [(x - y) * isoX, (x + y) * isoY - z * unit]
}

/**
 * Formats world points as an SVG polygon.
 *
 * @param points - World points.
 * @returns Polygon points attribute.
 */
function polygon(points: readonly (readonly [number, number, number])[]): string {
  return points.map(([x, y, z]) => project(x, y, z).join(',')).join(' ')
}

/** Colors of the three visible faces of a box. */
type BoxFaces = {
  /** Upper face. */
  top: string
  /** Face toward the viewer's lower left. */
  left: string
  /** Face toward the viewer's lower right. */
  right: string
}

/**
 * Draws a world-aligned box with its three visible faces.
 *
 * @param props - Corner, size, and face colors.
 * @param props.x - World x of the far corner.
 * @param props.y - World y of the far corner.
 * @param props.z - Height of the bottom face.
 * @param props.w - Size along x.
 * @param props.d - Size along y.
 * @param props.h - Height.
 * @param props.faces - Face colors.
 * @returns Box faces.
 */
function IsoBox({ x, y, z = 0, w, d, h, faces }: { x: number; y: number; z?: number; w: number; d: number; h: number; faces: BoxFaces }) {
  const top = z + h
  return (
    <g>
      <polygon points={polygon([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, top], [x, y + d, top]])} style={{ fill: faces.left }} />
      <polygon points={polygon([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, top], [x + w, y, top]])} style={{ fill: faces.right }} />
      <polygon points={polygon([[x, y, top], [x + w, y, top], [x + w, y + d, top], [x, y + d, top]])} style={{ fill: faces.top }} />
    </g>
  )
}

/** Plain machine faces. */
const machineFaces: BoxFaces = { top: colors.top, left: colors.left, right: colors.right }

/** Cardboard box faces of a task. */
const parcelFaces: BoxFaces = { top: colors.boxTape, left: colors.box, right: colors.boxSide }

/**
 * Draws the floor plate with a faint grid.
 *
 * @returns Floor.
 */
function Floor() {
  const lines: ReactNode[] = []
  for (let x = -6; x <= 42; x += 3) lines.push(<line key={`x${x}`} style={{ stroke: colors.floorLine }} strokeWidth={1} x1={project(x, -6)[0]} x2={project(x, 15)[0]} y1={project(x, -6)[1]} y2={project(x, 15)[1]} />)
  for (let y = -6; y <= 15; y += 3) lines.push(<line key={`y${y}`} style={{ stroke: colors.floorLine }} strokeWidth={1} x1={project(-6, y)[0]} x2={project(42, y)[0]} y1={project(-6, y)[1]} y2={project(42, y)[1]} />)
  return (
    <g>
      <polygon points={polygon([[-6, -6, 0], [42, -6, 0], [42, 15, 0], [-6, 15, 0]])} style={{ fill: colors.floor }} />
      {lines}
    </g>
  )
}

/**
 * Draws the conveyor along the main line, with rollers that run unless motion is reduced.
 *
 * @param props - Clip ID of the belt surface.
 * @param props.clipId - Unique clip path ID.
 * @returns Conveyor.
 */
function Conveyor({ clipId }: { clipId: string }) {
  const start = -3
  const end = stationSpacing * 5 + 3
  const stripes: ReactNode[] = []
  for (let x = start - 1; x <= end; x += 0.6) {
    const [x1, y1] = project(x, 2.2, 0.45)
    const [x2, y2] = project(x, 3.4, 0.45)
    stripes.push(<line key={x} style={{ stroke: colors.beltStripe }} strokeWidth={2} x1={x1} x2={x2} y1={y1} y2={y2} />)
  }
  return (
    <g>
      <IsoBox d={1.2} faces={{ top: colors.belt, left: colors.right, right: colors.left }} h={0.45} w={end - start} x={start} y={2.2} />
      <clipPath id={clipId}>
        <polygon points={polygon([[start, 2.2, 0.45], [end, 2.2, 0.45], [end, 3.4, 0.45], [start, 3.4, 0.45]])} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        {/* One roller step is 0.6 world units along the line; the keyframes move the rollers by exactly that. */}
        <g className="factory-line-belt">{stripes}</g>
      </g>
    </g>
  )
}

/**
 * Draws a task's parcel riding the belt.
 *
 * @param props - World position and whether the parcel is selected.
 * @param props.x - World x.
 * @param props.y - World y.
 * @param props.selected - Whether the parcel's task is selected.
 * @returns Parcel.
 */
function Parcel({ x, y, selected }: { x: number; y: number; selected: boolean }) {
  return (
    <g>
      <IsoBox d={0.7} faces={parcelFaces} h={0.6} w={0.7} x={x} y={y} z={0.45} />
      {selected ? (
        <polygon
          points={polygon([[x - 0.15, y - 0.15, 1.08], [x + 0.85, y - 0.15, 1.08], [x + 0.85, y + 0.85, 1.08], [x - 0.15, y + 0.85, 1.08]])}
          style={{ fill: 'none', stroke: colors.accent }}
          strokeWidth={2}
        />
      ) : null}
    </g>
  )
}

/**
 * Draws a robot worker standing at a world point.
 *
 * @param props - Position, runtime color, and whether the run stalled.
 * @param props.x - World x.
 * @param props.y - World y.
 * @param props.color - Body color.
 * @param props.stalled - Whether the run stalled; the robot stops and shows a warning.
 * @param props.delay - Animation offset in seconds, so neighbors do not move together.
 * @returns Robot.
 */
function Robot({ x, y, color, stalled, delay }: { x: number; y: number; color: string; stalled: boolean; delay: number }) {
  const [sx, sy] = project(x, y)
  return (
    <g transform={`translate(${sx} ${sy})`}>
      <ellipse cx={0} cy={0} rx={11} ry={5} style={{ fill: 'color-mix(in srgb, var(--workbench-text) 18%, transparent)' }} />
      <g className={stalled ? undefined : 'factory-line-worker'} style={{ animationDelay: `${delay}s`, opacity: stalled ? 0.55 : 1 }}>
        <rect height={14} rx={4} style={{ fill: color }} width={16} x={-8} y={-18} />
        <rect height={14} rx={5} style={{ fill: color }} width={20} x={-10} y={-34} />
        <rect height={7} rx={3} style={{ fill: '#111827' }} width={14} x={-7} y={-30} />
        <circle className={stalled ? undefined : 'factory-line-blink'} cx={-3} cy={-26.5} r={1.6} style={{ fill: stalled ? colors.warning : '#93c5fd' }} />
        <circle className={stalled ? undefined : 'factory-line-blink'} cx={3} cy={-26.5} r={1.6} style={{ fill: stalled ? colors.warning : '#93c5fd' }} />
        <line strokeWidth={1.5} style={{ stroke: color }} x1={0} x2={0} y1={-34} y2={-39} />
        <circle cx={0} cy={-40} r={2} style={{ fill: stalled ? colors.warning : colors.accent }} />
      </g>
      {stalled ? <Alert x={10} y={-44} tone={colors.warning} /> : null}
    </g>
  )
}

/**
 * Draws a person standing at a world point.
 *
 * @param props - Position and shirt color.
 * @param props.x - World x.
 * @param props.y - World y.
 * @param props.color - Shirt color.
 * @param props.delay - Animation offset in seconds.
 * @returns Person.
 */
function Person({ x, y, color, delay }: { x: number; y: number; color: string; delay: number }) {
  const [sx, sy] = project(x, y)
  return (
    <g transform={`translate(${sx} ${sy})`}>
      <ellipse cx={0} cy={0} rx={10} ry={4.5} style={{ fill: 'color-mix(in srgb, var(--workbench-text) 18%, transparent)' }} />
      <g className="factory-line-person" style={{ animationDelay: `${delay}s` }}>
        <rect height={12} rx={3} style={{ fill: '#1f2937' }} width={10} x={-5} y={-12} />
        <rect height={16} rx={5} style={{ fill: color }} width={16} x={-8} y={-27} />
        <circle cx={0} cy={-33} r={7} style={{ fill: colors.skin }} />
        <path d="M -7 -34 Q 0 -44 7 -34 L 7 -36 Q 0 -46 -7 -36 Z" style={{ fill: colors.hair }} />
        <rect height={8} rx={1.5} style={{ fill: 'var(--workbench-surface)', stroke: colors.muted }} strokeWidth={0.8} width={7} x={5} y={-24} />
      </g>
    </g>
  )
}

/**
 * Draws a round warning marker.
 *
 * @param props - Position and tone.
 * @param props.x - Screen x relative to the parent.
 * @param props.y - Screen y relative to the parent.
 * @param props.tone - Marker color.
 * @returns Marker.
 */
function Alert({ x, y, tone }: { x: number; y: number; tone: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={7} style={{ fill: tone }} />
      <text fontSize={10} fontWeight={700} style={{ fill: '#fff' }} textAnchor="middle" y={3.5}>!</text>
    </g>
  )
}

/**
 * Draws the machine of one station, with a status light that blinks while the station has work.
 *
 * @param props - Station and whether it holds work.
 * @param props.station - Station.
 * @param props.busy - Whether any task is at the station.
 * @param props.focused - Whether the camera follows the station.
 * @returns Machine.
 */
function Machine({ station, busy, focused }: { station: FactoryLineStation; busy: boolean; focused: boolean }) {
  const { x, y } = stationPositions[station]
  const left = x - 1.4
  const far = y - 1.6
  const tone = station === 'repair' ? colors.danger : station === 'done' ? colors.success : colors.accent
  const [lx, ly] = project(x + 1.4, y - 0.2, 1.7)
  return (
    <g>
      {focused ? (
        <polygon
          className="factory-line-focus"
          points={polygon([[left - 0.6, far - 0.8, 0], [x + 6.6, far - 0.8, 0], [x + 6.6, y + 5.8, 0], [left - 0.6, y + 5.8, 0]])}
          style={{ fill: 'color-mix(in srgb, var(--workbench-primary) 10%, transparent)', stroke: colors.accent }}
          strokeDasharray="6 5"
          strokeWidth={2}
        />
      ) : null}
      <IsoBox d={2.6} faces={machineFaces} h={1.9} w={2.8} x={left} y={far} />
      <IsoBox d={2.6} faces={{ top: tone, left: `color-mix(in srgb, ${tone} 80%, #000)`, right: `color-mix(in srgb, ${tone} 65%, #000)` }} h={0.25} w={2.8} x={left} y={far} z={1.9} />
      <MachineDetail station={station} />
      <circle className={busy ? 'factory-line-blink' : undefined} cx={lx} cy={ly} r={3.2} style={{ fill: busy ? colors.success : colors.muted }} />
    </g>
  )
}

/**
 * Draws the part that tells stations apart at a glance: a screen, a gate, a crate stack, a desk, or a truck.
 *
 * @param props - Station.
 * @param props.station - Station.
 * @returns Detail shapes.
 */
function MachineDetail({ station }: { station: FactoryLineStation }) {
  const { x, y } = stationPositions[station]
  switch (station) {
    case 'build':
    case 'verify': {
      const lines = [0, 1, 2].map((row) => {
        const [x1, y1] = project(x - 1.1, y + 1.0, 1.45 - row * 0.3)
        const [x2, y2] = project(x + (row === 1 ? 0.2 : 0.8), y + 1.0, 1.45 - row * 0.3)
        return <line key={row} strokeWidth={1.6} style={{ stroke: station === 'verify' ? '#4ade80' : '#93c5fd' }} x1={x1} x2={x2} y1={y1} y2={y2} />
      })
      return (
        <g>
          <polygon points={polygon([[x - 1.25, y + 1.0, 0.4], [x + 1.25, y + 1.0, 0.4], [x + 1.25, y + 1.0, 1.65], [x - 1.25, y + 1.0, 1.65]])} style={{ fill: '#111827' }} />
          {lines}
        </g>
      )
    }
    case 'artifact':
      return (
        <g>
          <IsoBox d={0.8} faces={parcelFaces} h={0.6} w={0.8} x={x - 1.2} y={y - 1.4} z={2.15} />
          <IsoBox d={0.8} faces={parcelFaces} h={0.6} w={0.8} x={x - 0.2} y={y - 1.4} z={2.15} />
        </g>
      )
    case 'decision':
      return <IsoBox d={1.2} faces={{ top: colors.accentSoft, left: colors.left, right: colors.right }} h={0.9} w={1.6} x={x - 0.8} y={y + 1.2} />
    case 'done':
      return (
        <g>
          <IsoBox d={2.2} faces={{ top: colors.accentSoft, left: colors.accent, right: `color-mix(in srgb, ${colors.accent} 70%, #000)` }} h={1.6} w={3.2} x={x + 2.2} y={y - 1.2} />
          <IsoBox d={2.2} faces={machineFaces} h={1.1} w={1.2} x={x + 5.4} y={y - 1.2} />
        </g>
      )
    case 'repair':
      return <IsoBox d={0.5} faces={{ top: colors.danger, left: colors.left, right: colors.right }} h={0.2} w={2.4} x={x - 1.2} y={y + 1.2} z={0.9} />
    case 'intake':
      return <IsoBox d={1.8} faces={{ top: colors.boxTape, left: colors.box, right: colors.boxSide }} h={0.9} w={1.2} x={x - 3.2} y={y - 1.2} />
  }
}

/**
 * Draws the sign above one station with its number, name, and task count.
 *
 * @param props - Station, sign text, and count.
 * @param props.station - Station.
 * @param props.index - Station number on the main line; absent for the repair bay.
 * @param props.name - Station name.
 * @param props.count - Number of tasks at the station.
 * @param props.focused - Whether the camera follows the station.
 * @returns Sign.
 */
function StationSign({ station, index, name, count, focused }: { station: FactoryLineStation; index?: number; name: string; count: number; focused: boolean }) {
  const { x, y } = stationPositions[station]
  const [sx, sy] = project(x, y - 1.6, 3.6)
  const number = index === undefined ? '!' : String(index + 1).padStart(2, '0')
  const wide = Array.from(name).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
  const width = 34 + name.length * (wide ? 12 : 7) + 22
  return (
    <g transform={`translate(${sx - width / 2} ${sy - 26})`}>
      <line strokeWidth={1.5} style={{ stroke: colors.muted }} x1={width / 2} x2={width / 2} y1={24} y2={34} />
      <rect height={24} rx={6} style={{ fill: 'var(--workbench-surface)', stroke: focused ? colors.accent : 'var(--workbench-border)' }} strokeWidth={focused ? 2 : 1} width={width} />
      <rect height={14} rx={3} style={{ fill: station === 'repair' ? colors.danger : colors.accent }} width={20} x={6} y={5} />
      <text fontSize={9} fontWeight={700} style={{ fill: '#fff' }} textAnchor="middle" x={16} y={15}>{number}</text>
      <text fontSize={12} fontWeight={700} style={{ fill: colors.text }} x={32} y={16}>{name}</text>
      <text fontSize={11} fontWeight={700} style={{ fill: count > 0 ? colors.accent : colors.muted }} textAnchor="end" x={width - 8} y={16}>{count}</text>
    </g>
  )
}

/**
 * Draws the parcels and workers of one station, at most {@link drawnPerStation} of each.
 *
 * @param props - Station, its tasks, and the selected task.
 * @param props.station - Station.
 * @param props.entries - Tasks at the station.
 * @param props.selectedWorkItemId - Selected task, highlighted when drawn.
 * @returns Parcels and workers.
 */
function StationWork({ station, entries, selectedWorkItemId }: { station: FactoryLineStation; entries: readonly FactoryLineEntry[]; selectedWorkItemId?: string }) {
  const { x, y } = stationPositions[station]
  const drawn = entries.slice(0, drawnPerStation)
  const onLine = station !== 'repair'
  return (
    <g>
      {drawn.map((entry, index) => (
        <Parcel
          key={`parcel-${entry.item.workItem.id}`}
          selected={entry.item.workItem.id === selectedWorkItemId}
          // Points in front of a machine sit further along x by their distance across the line, so
          // they appear in front of it rather than in front of the previous station.
          x={onLine ? x + 1.0 + index * 1.05 : x + 0.2 + index * 0.9}
          y={onLine ? 2.45 : y + 1.4}
        />
      ))}
      {drawn.map((entry, index) => {
        const wy = onLine ? 4.6 : y + 3.2
        const wx = x + (wy - y) - 1.4 + index * 1.4
        const delay = index * 0.35
        if (station === 'intake' || station === 'decision') {
          return <Person color={station === 'decision' ? colors.person : '#0f766e'} delay={delay} key={`worker-${entry.item.workItem.id}`} x={wx} y={wy} />
        }
        if (station === 'done') return null
        const runtime = entry.item.run?.runtime ?? 'other'
        return <Robot color={runtimeColors[runtime]} delay={delay} key={`worker-${entry.item.workItem.id}`} stalled={entry.stalled || station === 'repair'} x={wx} y={wy} />
      })}
    </g>
  )
}

/**
 * Reads the camera transform that centers a station, or the identity for the whole line.
 *
 * @param station - Station the camera follows.
 * @returns CSS transform of the scene group.
 */
function readCameraTransform(station: FactoryLineStation | undefined): string {
  if (station === undefined) return 'translate(0px, 0px) scale(1)'
  const { x, y } = stationPositions[station]
  const [px, py] = project(x + 0.5, y + 2.5, 1)
  const cx = viewBox.x + viewBox.width / 2
  const cy = viewBox.y + viewBox.height / 2
  return `translate(${cx - px * stationZoom}px, ${cy - py * stationZoom}px) scale(${stationZoom})`
}

/** Props of the line scene. */
export type FactoryLineSceneProps = {
  /** Stations with their tasks, in display order. */
  groups: readonly FactoryLineStationGroup[]
  /** Station the camera follows; the whole line when absent. */
  focusedStation?: FactoryLineStation
  /** Selected task, highlighted on the line. */
  selectedWorkItemId?: string
  /** Chooses a station when its machine is clicked. */
  onFocusStation: (station: FactoryLineStation) => void
  /** Locale-aware text. */
  labels: FactoryLineLabels
  /** Unique prefix for SVG IDs. */
  idPrefix: string
}

/**
 * Draws the Team's work as an isometric factory: one machine per station on a running conveyor, tasks
 * as parcels, agent runs as robots, and people where a person has to act. The camera eases toward the
 * focused station. The scene is a picture; the station bar and panel beside it carry the same
 * information for keyboard and screen reader use.
 *
 * @param props - Stations, focus, selection, and text.
 * @returns Scene.
 */
export function FactoryLineScene({ groups, focusedStation, selectedWorkItemId, onFocusStation, labels, idPrefix }: FactoryLineSceneProps) {
  const summary = groups.map((group) => `${labels.stations[group.station]} ${labels.count.replace('{count}', String(group.entries.length))}`).join('、')
  return (
    <svg
      aria-describedby={`${idPrefix}-desc`}
      aria-labelledby={`${idPrefix}-title`}
      className="block h-auto w-full select-none"
      role="img"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
    >
      <title id={`${idPrefix}-title`}>{labels.sceneLabel}</title>
      <desc id={`${idPrefix}-desc`}>{labels.sceneSummary.replace('{summary}', summary)}</desc>
      <g className="factory-line-camera" style={{ transform: readCameraTransform(focusedStation) }}>
        <Floor />
        <Conveyor clipId={`${idPrefix}-belt`} />
        {groups.map((group, index) => (
          <g className="cursor-pointer" key={group.station} onClick={() => onFocusStation(group.station)}>
            <Machine busy={group.entries.length > 0} focused={group.station === focusedStation} station={group.station} />
            <StationWork entries={group.entries} selectedWorkItemId={selectedWorkItemId} station={group.station} />
            <StationSign
              count={group.entries.length}
              focused={group.station === focusedStation}
              {...(group.station === 'repair' ? {} : { index })}
              name={labels.stations[group.station]}
              station={group.station}
            />
          </g>
        ))}
      </g>
    </svg>
  )
}
