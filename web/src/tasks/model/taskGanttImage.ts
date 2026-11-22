/** Kind of one bar drawn in an exported Gantt image. */
export type TaskGanttImageBarKind =
  | 'date-range'
  | 'milestone'
  | 'due-date'
  | 'summary'
  | 'actual'
  | 'baseline'

/** One bar of a task row, positioned in timeline coordinates relative to its row. */
export type TaskGanttImageBar = {
  /** What the bar represents, which decides its shape and colors. */
  kind: TaskGanttImageBarKind
  /** Left edge in timeline pixels. */
  left: number
  /** Width in pixels. */
  width: number
  /** Top edge relative to the row's top. */
  top: number
  /** Height in pixels. */
  height: number
  /** Progress from 0 to 100 drawn as a fill inside a planned date-range bar. */
  progressPercent?: number
}

/** One row of the exported chart. */
export type TaskGanttImageRow =
  | {
      /** Heading row of a group, such as a Project. */
      kind: 'group'
      /** Group heading text, including its count. */
      label: string
    }
  | {
      /** Row of one Work Item. */
      kind: 'task'
      /** WBS number and title shown in the label column. */
      label: string
      /** Left indent of the label for an outline level. */
      indent: number
      /** Bars drawn in the timeline. */
      bars: readonly TaskGanttImageBar[]
    }

/** One header column of the exported timeline. */
export type TaskGanttImageColumn = {
  /** Header text. */
  label: string
  /** Whether the column contains today. */
  isToday: boolean
  /** Whether the column is a single non-working day. */
  isNonWorking: boolean
}

/** Dependency connector in chart coordinates (timeline x, y from the top of the rows area). */
export type TaskGanttImageConnector = {
  /** SVG path data. */
  path: string
  /** Whether the edge is on the critical path. */
  critical: boolean
  /** Whether the edge has a scheduling conflict. */
  conflict: boolean
}

/** Label of a cross-Project endpoint in the external lane, in chart coordinates. */
export type TaskGanttImageExternalStub = {
  /** Center x in timeline pixels. */
  x: number
  /** Center y from the top of the rows area. */
  y: number
  /** Text of the stub. */
  label: string
}

/** Everything needed to draw the full Gantt chart as one image, independent of the DOM. */
export type TaskGanttImageInput = {
  /** Title printed above the chart. */
  title: string
  /** Header text of the label column. */
  labelHeader: string
  /** Width of the label column. */
  labelWidth: number
  /** Timeline header columns, in order. */
  columns: readonly TaskGanttImageColumn[]
  /** Width of one timeline column. */
  columnWidth: number
  /** Rows in display order. */
  rows: readonly TaskGanttImageRow[]
  /** Top of each row from the top of the task rows, with the total height as the last entry. */
  rowTops: readonly number[]
  /** Height of the cross-Project lane above the task rows; 0 without one. */
  externalLaneHeight: number
  /** Header text of the cross-Project lane. */
  externalLaneLabel?: string
  /** Cross-Project endpoint labels drawn in the lane. */
  externalStubs?: readonly TaskGanttImageExternalStub[]
  /** Shaded non-working spans in timeline pixels. */
  nonWorkingSpans?: readonly { left: number, right: number }[]
  /** Today's x in timeline pixels, when today is on the axis. */
  todayX?: number
  /** Progress line points in chart coordinates. */
  progressLinePoints?: readonly { x: number, y: number }[]
  /** Dependency connectors in chart coordinates. */
  connectors?: readonly TaskGanttImageConnector[]
}

/** Rendered SVG document and its pixel size. */
export type TaskGanttImage = {
  /** Standalone SVG markup. */
  svg: string
  /** Image width in CSS pixels. */
  width: number
  /** Image height in CSS pixels. */
  height: number
}

/** Height of the title band above the chart. */
const TITLE_HEIGHT = 40
/** Height of the timeline header. */
const HEADER_HEIGHT = 32
/** Inner padding of the label column. */
const LABEL_PADDING = 12
/** Font size of labels. */
const LABEL_FONT_SIZE = 12
/** Font stack that resolves to a Japanese-capable system font in common browsers. */
const FONT_FAMILY = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'Noto Sans CJK JP', 'Noto Sans JP', sans-serif"
/**
 * Largest canvas side and area that current browsers rasterize reliably. Larger charts are
 * drawn at a lower pixel ratio, down to 1.
 */
const MAX_CANVAS_SIDE = 16_384
const MAX_CANVAS_AREA = 120_000_000

/** Fixed light colors, because CSS variables of the app theme do not reach an exported file. */
const colors = {
  actual: '#2e90fa',
  background: '#ffffff',
  baseline: '#98a2b3',
  border: '#d8dde5',
  conflict: '#d92d20',
  critical: '#c4320a',
  dateRangeFill: '#ccfbea',
  dateRangeProgress: '#5fd3bc',
  dateRangeStroke: '#0e9384',
  dueFill: '#fffaeb',
  dueStroke: '#dc6803',
  grid: '#e4e7ec',
  headerFill: '#f8fafb',
  link: '#667085',
  milestoneFill: '#ebe9fe',
  milestoneStroke: '#7f56d9',
  muted: '#667085',
  nonWorking: '#f2f4f7',
  summary: '#344054',
  text: '#101828',
  today: '#d92d20',
  todayFill: '#fef3f2',
}

/**
 * Escapes text for use inside SVG text content and attribute values.
 *
 * @param value - Raw text.
 * @returns XML-safe text.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Estimates the drawn width of one character, since an SVG file cannot measure its own text.
 *
 * @param character - One code point.
 * @param fontSize - Font size in pixels.
 * @returns Approximate advance width.
 */
function estimateCharacterWidth(character: string, fontSize: number): number {
  const codePoint = character.codePointAt(0) ?? 0
  // CJK, kana, and full-width forms take about one em; Latin text averages about 0.6 em.
  return codePoint >= 0x2e80 ? fontSize : fontSize * 0.6
}

/**
 * Shortens text with an ellipsis so it fits a width, because SVG text does not wrap or clip.
 *
 * @param text - Label text.
 * @param maxWidth - Available width in pixels.
 * @param fontSize - Font size in pixels.
 * @returns The text, or a prefix ending in an ellipsis.
 */
export function truncateTaskGanttImageLabel(text: string, maxWidth: number, fontSize = LABEL_FONT_SIZE): string {
  const characters = Array.from(text)
  let width = 0
  for (const [index, character] of characters.entries()) {
    width += estimateCharacterWidth(character, fontSize)
    if (width > maxWidth) {
      const ellipsisWidth = fontSize
      let kept = index
      let keptWidth = width - estimateCharacterWidth(character, fontSize)
      while (kept > 0 && keptWidth + ellipsisWidth > maxWidth) {
        kept -= 1
        keptWidth -= estimateCharacterWidth(characters[kept] ?? '', fontSize)
      }
      return `${characters.slice(0, kept).join('')}…`
    }
  }
  return text
}

/**
 * Formats a number for SVG attributes without long floating-point tails.
 *
 * @param value - Coordinate or length.
 * @returns Compact decimal text.
 */
function n(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/**
 * Draws one bar of a task row.
 *
 * @param bar - Bar geometry and kind.
 * @param x0 - Left edge of the timeline in the image.
 * @param rowTop - Top of the row in the image.
 * @returns SVG markup of the bar.
 */
function renderBar(bar: TaskGanttImageBar, x0: number, rowTop: number): string {
  const x = x0 + bar.left
  const y = rowTop + bar.top
  switch (bar.kind) {
    case 'date-range': {
      const progress = Math.min(100, Math.max(0, bar.progressPercent ?? 0))
      return [
        `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width)}" height="${n(bar.height)}" rx="5" fill="${colors.dateRangeFill}" stroke="${colors.dateRangeStroke}"/>`,
        progress > 0
          ? `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width * progress / 100)}" height="${n(bar.height)}" rx="5" fill="${colors.dateRangeProgress}"/>`
          : '',
      ].join('')
    }
    case 'milestone': {
      // The diamond spans the bar's width, so dependency connectors anchored at the bar's edges
      // meet its tips as they do on screen.
      const cx = x + bar.width / 2
      const cy = y + bar.height / 2
      return `<path d="M${n(x)} ${n(cy)} L${n(cx)} ${n(y)} L${n(x + bar.width)} ${n(cy)} L${n(cx)} ${n(y + bar.height)} Z" fill="${colors.milestoneFill}" stroke="${colors.milestoneStroke}"/>`
    }
    case 'due-date':
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width)}" height="${n(bar.height)}" rx="${n(bar.height / 2)}" fill="${colors.dueFill}" stroke="${colors.dueStroke}" stroke-width="2" stroke-dasharray="4 3"/>`
    case 'summary':
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width)}" height="${n(bar.height)}" rx="2" fill="${colors.summary}"/>`
    case 'actual':
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width)}" height="${n(bar.height)}" rx="2" fill="${colors.actual}"/>`
    case 'baseline':
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(bar.width)}" height="${n(bar.height)}" rx="2" fill="${colors.baseline}"/>`
  }
}

/**
 * Draws the whole Gantt chart, every row included, as a standalone SVG document.
 *
 * The chart on screen only creates the rows near the visible part, so the image is drawn from the
 * same layout values instead of being captured from the page.
 *
 * @param input - Chart layout, rows, and overlays.
 * @returns SVG markup and its size.
 */
export function createTaskGanttImage(input: TaskGanttImageInput): TaskGanttImage {
  const timelineWidth = input.columns.length * input.columnWidth
  const width = input.labelWidth + timelineWidth
  const rowsHeight = input.rowTops.at(-1) ?? 0
  const chartTop = TITLE_HEIGHT + HEADER_HEIGHT
  const rowsTop = chartTop + input.externalLaneHeight
  const height = rowsTop + rowsHeight
  const x0 = input.labelWidth
  const parts: string[] = []

  parts.push(`<rect width="${n(width)}" height="${n(height)}" fill="${colors.background}"/>`)
  parts.push(
    `<text x="${LABEL_PADDING}" y="${TITLE_HEIGHT / 2 + 6}" font-size="16" font-weight="700" fill="${colors.text}">${escapeXml(truncateTaskGanttImageLabel(input.title, width - LABEL_PADDING * 2, 16))}</text>`,
  )

  // Header.
  parts.push(`<rect x="0" y="${TITLE_HEIGHT}" width="${n(width)}" height="${HEADER_HEIGHT}" fill="${colors.headerFill}"/>`)
  parts.push(
    `<text x="${LABEL_PADDING}" y="${TITLE_HEIGHT + HEADER_HEIGHT / 2 + 4}" font-size="11" font-weight="700" fill="${colors.muted}">${escapeXml(input.labelHeader)}</text>`,
  )
  input.columns.forEach((column, index) => {
    const x = x0 + index * input.columnWidth
    if (column.isToday || column.isNonWorking) {
      parts.push(
        `<rect x="${n(x)}" y="${TITLE_HEIGHT}" width="${n(input.columnWidth)}" height="${HEADER_HEIGHT}" fill="${column.isToday ? colors.todayFill : colors.nonWorking}"/>`,
      )
    }
    parts.push(
      `<text x="${n(x + input.columnWidth / 2)}" y="${TITLE_HEIGHT + HEADER_HEIGHT / 2 + 4}" font-size="10" font-weight="600" text-anchor="middle" fill="${column.isToday ? colors.today : colors.muted}">${escapeXml(truncateTaskGanttImageLabel(column.label, input.columnWidth - 4, 10))}</text>`,
    )
    parts.push(`<line x1="${n(x + input.columnWidth)}" y1="${TITLE_HEIGHT}" x2="${n(x + input.columnWidth)}" y2="${n(height)}" stroke="${colors.grid}"/>`)
  })

  // Non-working days under the bars.
  for (const span of input.nonWorkingSpans ?? []) {
    parts.push(`<rect x="${n(x0 + span.left)}" y="${chartTop}" width="${n(span.right - span.left)}" height="${n(height - chartTop)}" fill="${colors.nonWorking}"/>`)
  }

  // Cross-Project lane.
  if (input.externalLaneHeight > 0) {
    parts.push(`<rect x="0" y="${chartTop}" width="${n(input.labelWidth)}" height="${n(input.externalLaneHeight)}" fill="${colors.headerFill}"/>`)
    if (input.externalLaneLabel) {
      parts.push(`<text x="${LABEL_PADDING}" y="${chartTop + 22}" font-size="11" font-weight="700" fill="${colors.muted}">${escapeXml(truncateTaskGanttImageLabel(input.externalLaneLabel, input.labelWidth - LABEL_PADDING * 2, 11))}</text>`)
    }
    parts.push(`<line x1="0" y1="${n(rowsTop)}" x2="${n(width)}" y2="${n(rowsTop)}" stroke="${colors.border}"/>`)
  }

  // Rows.
  input.rows.forEach((row, index) => {
    const top = rowsTop + (input.rowTops[index] ?? 0)
    const bottom = rowsTop + (input.rowTops[index + 1] ?? input.rowTops[index] ?? 0)
    const rowHeight = bottom - top
    if (row.kind === 'group') {
      parts.push(`<rect x="0" y="${n(top)}" width="${n(width)}" height="${n(rowHeight)}" fill="${colors.headerFill}"/>`)
      parts.push(`<text x="${LABEL_PADDING}" y="${n(top + rowHeight / 2 + 4)}" font-size="13" font-weight="700" fill="${colors.text}">${escapeXml(truncateTaskGanttImageLabel(row.label, input.labelWidth - LABEL_PADDING * 2, 13))}</text>`)
    } else {
      const labelX = LABEL_PADDING + row.indent
      parts.push(`<text x="${n(labelX)}" y="${n(top + Math.min(rowHeight / 2, 24) + 4)}" font-size="${LABEL_FONT_SIZE}" font-weight="600" fill="${colors.text}">${escapeXml(truncateTaskGanttImageLabel(row.label, input.labelWidth - labelX - LABEL_PADDING))}</text>`)
      for (const bar of row.bars) parts.push(renderBar(bar, x0, top))
    }
    parts.push(`<line x1="0" y1="${n(bottom)}" x2="${n(width)}" y2="${n(bottom)}" stroke="${colors.grid}"/>`)
  })

  // Overlays share the chart coordinates, whose y starts at the top of the cross-Project lane.
  const overlays: string[] = []
  for (const stub of input.externalStubs ?? []) {
    const label = truncateTaskGanttImageLabel(stub.label, 200, 11)
    const stubWidth = Math.min(220, Array.from(label).reduce((sum, character) => sum + estimateCharacterWidth(character, 11), 0) + 16)
    // The label stays inside the timeline even when its connector anchor is near an edge.
    const stubLeft = Math.max(2, Math.min(stub.x - stubWidth / 2, timelineWidth - stubWidth - 2))
    overlays.push(`<rect x="${n(stubLeft)}" y="${n(stub.y - 12)}" width="${n(stubWidth)}" height="24" rx="12" fill="${colors.background}" stroke="${colors.baseline}"/>`)
    overlays.push(`<text x="${n(stubLeft + stubWidth / 2)}" y="${n(stub.y + 4)}" font-size="11" font-weight="700" text-anchor="middle" fill="${colors.summary}">${escapeXml(label)}</text>`)
  }
  for (const connector of input.connectors ?? []) {
    const stroke = connector.conflict ? colors.conflict : connector.critical ? colors.critical : colors.link
    const marker = connector.conflict ? 'conflict' : connector.critical ? 'critical' : 'default'
    overlays.push(`<path d="${escapeXml(connector.path)}" fill="none" stroke="${stroke}" stroke-width="${connector.critical || connector.conflict ? 2.5 : 2}"${connector.conflict ? ' stroke-dasharray="5 3"' : ''} stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow-${marker})"/>`)
  }
  if (input.todayX !== undefined) {
    overlays.push(`<line x1="${n(input.todayX)}" y1="0" x2="${n(input.todayX)}" y2="${n(input.externalLaneHeight + rowsHeight)}" stroke="${colors.today}" stroke-width="2"/>`)
  }
  if (input.progressLinePoints && input.progressLinePoints.length > 1) {
    overlays.push(`<polyline points="${input.progressLinePoints.map((point) => `${n(point.x)},${n(point.y)}`).join(' ')}" fill="none" stroke="${colors.today}" stroke-width="2" stroke-linejoin="round"/>`)
  }

  const markers = (['default', 'critical', 'conflict'] as const).map((marker) => {
    const fill = marker === 'conflict' ? colors.conflict : marker === 'critical' ? colors.critical : colors.link
    return `<marker id="arrow-${marker}" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0 0 L7 3.5 L0 7 Z" fill="${fill}"/></marker>`
  }).join('')

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" font-family="${escapeXml(FONT_FAMILY)}">`,
    `<defs>${markers}</defs>`,
    ...parts,
    `<g transform="translate(${n(x0)} ${chartTop})">${overlays.join('')}</g>`,
    // The border between the label column and the timeline.
    `<line x1="${n(x0)}" y1="${TITLE_HEIGHT}" x2="${n(x0)}" y2="${n(height)}" stroke="${colors.border}"/>`,
    '</svg>',
  ].join('')
  return { height, svg, width }
}

/**
 * Chooses the pixel ratio for a PNG so the canvas stays within browser limits.
 *
 * @param width - Image width in CSS pixels.
 * @param height - Image height in CSS pixels.
 * @param preferredRatio - Ratio wanted for a sharp image.
 * @returns A ratio of at most `preferredRatio`, or undefined when even 1 is too large.
 */
export function resolveTaskGanttImagePixelRatio(
  width: number,
  height: number,
  preferredRatio = 2,
): number | undefined {
  for (let ratio = preferredRatio; ratio >= 1; ratio -= 0.5) {
    const canvasWidth = Math.ceil(width * ratio)
    const canvasHeight = Math.ceil(height * ratio)
    if (
      canvasWidth <= MAX_CANVAS_SIDE &&
      canvasHeight <= MAX_CANVAS_SIDE &&
      canvasWidth * canvasHeight <= MAX_CANVAS_AREA
    ) return ratio
  }
  return undefined
}
