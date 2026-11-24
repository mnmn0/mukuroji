import {
  PROJECT_STATUS_REPORT_MAX_ROWS,
  PROJECT_STATUS_REPORT_SCHEMA_VERSION,
  PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH,
  PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH,
  createProjectStatusReportOutline,
  type PlanningUpdateTargetSummary,
  type ProjectStatusReport,
  type ProjectStatusReportScheduleType,
} from '@mukuroji/contracts'
import { createZipArchive } from '../../shared/lib/zipArchive'
import type { ProjectMember } from '../api/members'
import type {
  ProjectOverviewActionItems,
  ProjectOverviewRaid,
  ProjectOverviewSchedule,
  ProjectOverviewWorkItemSummary,
} from './projectOverview'

/** Most rows of each list section a report built from the overview holds. */
export const PROJECT_STATUS_REPORT_ROW_LIMIT = 20

/** Overview data a status report is built from; a missing part leaves its section out. */
export type ProjectStatusReportSource = {
  /** Language of the report labels. */
  locale: 'ja' | 'en'
  /** Project display name. */
  projectName: string
  /** Team display name. */
  teamName: string
  /** Snapshot time. */
  asOf: Date
  /** Update target of the Project, with its latest published update. */
  updateTarget?: PlanningUpdateTargetSummary
  /** Phases, Milestones, and Releases. */
  schedule?: ProjectOverviewSchedule
  /** Work Item counts. */
  workItemSummary?: ProjectOverviewWorkItemSummary
  /** Open risks and issues. */
  raid?: ProjectOverviewRaid
  /** Open Document action items. */
  actionItems?: ProjectOverviewActionItems
  /** Project members, used to name the update author and the action item owners. */
  members: readonly ProjectMember[]
}

/** Planning entity kinds the schedule section lists. */
const scheduleTypes: ReadonlySet<string> = new Set<ProjectStatusReportScheduleType>(['phase', 'milestone', 'release'])

/**
 * Builds a status report snapshot from the data the Project overview has read.
 *
 * Only display names are written, never e-mail addresses or member keys, so that a report
 * shared outside the Workspace names people at most by the name they chose.
 *
 * @param source - Overview data.
 * @returns The report snapshot.
 */
export function buildProjectStatusReport(source: ProjectStatusReportSource): ProjectStatusReport {
  const names = new Map(source.members.flatMap((member) =>
    member.name?.trim() ? [[member.id, member.name.trim()] as const] : []))
  const report: ProjectStatusReport = {
    schemaVersion: PROJECT_STATUS_REPORT_SCHEMA_VERSION,
    locale: source.locale,
    projectName: clip(source.projectName, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
    teamName: clip(source.teamName, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
    asOf: source.asOf.toISOString(),
  }
  const latest = source.updateTarget?.latestUpdate
  if (latest) {
    const authorName = names.get(latest.authorMemberKey)
    report.health = {
      health: latest.health,
      risk: latest.risk,
      summary: clip(latest.summary, PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH),
      publishedAt: latest.createdAt,
      ...(authorName ? { authorName: clip(authorName, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH) } : {}),
    }
  }
  if (source.schedule) {
    const items = source.schedule.items.filter((item) => scheduleTypes.has(item.type))
    const rows = items.slice(0, PROJECT_STATUS_REPORT_MAX_ROWS)
    report.schedule = {
      items: rows.map((item) => ({
        type: item.type === 'phase' || item.type === 'release' ? item.type : 'milestone',
        title: clip(item.title, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
        status: item.status,
        health: item.health,
        progress: Math.min(100, Math.max(0, Math.round(item.progress))),
        forecastEndDate: item.forecastEndDate,
        baselineEndDate: item.baselineEndDate,
        delayDays: item.delayDays,
      })),
      hiddenCount: source.schedule.hiddenCount + items.length - rows.length,
      delayedCount: source.schedule.delayedCount,
    }
  }
  if (source.workItemSummary) {
    const summary = source.workItemSummary
    report.progress = {
      totalCount: summary.totalCount,
      openCount: summary.openCount,
      inProgressCount: summary.inProgressCount,
      doneCount: summary.doneCount,
      completionRate: summary.completionRate,
      overdueCount: summary.overdueCount,
      blockedCount: summary.blockedCount,
    }
  }
  if (source.raid) {
    const raid = source.raid
    const rows = raid.attention.flatMap((item) => item.kind === 'change-request' ? [] : [{ ...item, kind: item.kind }])
      .slice(0, PROJECT_STATUS_REPORT_MAX_ROWS)
    report.risks = {
      openRiskCount: raid.openRiskCount,
      openIssueCount: raid.openIssueCount,
      pendingDecisionCount: raid.pendingDecisionCount,
      items: rows.map((item) => ({
        kind: item.kind,
        title: clip(item.title, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH),
        severity: item.severity,
        ...(item.response ? { response: clip(item.response, PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH) } : {}),
        ...(item.reviewDueDate ? { reviewDueDate: item.reviewDueDate } : {}),
      })),
      hiddenCount: raid.hiddenAttentionCount + raid.attention.length - rows.length,
    }
  }
  if (source.actionItems) {
    const actions = source.actionItems
    const rows = actions.items.slice(0, PROJECT_STATUS_REPORT_MAX_ROWS)
    report.nextActions = {
      items: rows.map((item) => {
        const ownerName = item.assigneeMemberKey ? names.get(item.assigneeMemberKey) : undefined
        return {
          text: clip(item.text, PROJECT_STATUS_REPORT_TEXT_MAX_LENGTH),
          ...(item.dueDate ? { dueDate: item.dueDate } : {}),
          ...(ownerName ? { ownerName: clip(ownerName, PROJECT_STATUS_REPORT_TITLE_MAX_LENGTH) } : {}),
          overdue: item.overdue,
        }
      }),
      hiddenCount: actions.hiddenCount + actions.items.length - rows.length,
      // Unread Documents are not "no actions": the report says so instead of looking complete.
      ...(actions.failedDocumentCount > 0 || actions.hasUnscannedDocuments ? { incomplete: true } : {}),
    }
  }
  return report
}

/**
 * Builds a safe download file name for a report.
 *
 * @param report - Report.
 * @param extension - File extension without the dot.
 * @returns A file name such as `Project-status-2026-11-23.pdf`.
 */
export function createProjectStatusReportFileName(report: ProjectStatusReport, extension: string) {
  // eslint-disable-next-line no-control-regex -- control characters are what the file name drops.
  const name = report.projectName.replace(/[\\/:*?"<>|\u0000-\u001F]+/gu, '-').trim().slice(0, 80) || 'project'
  return `${name}-status-${report.asOf.slice(0, 10)}.${extension}`
}

/** Slide width of a 16:9 deck, in EMU. */
const SLIDE_WIDTH = 12_192_000
/** Slide height of a 16:9 deck, in EMU. */
const SLIDE_HEIGHT = 6_858_000
/** Most lines a section shows on the slide before it says how many it left out. */
const SLIDE_SECTION_LINE_LIMIT = 6
/** XML declaration every part starts with. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
/** DrawingML namespace declarations. */
const NAMESPACES = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/**
 * Writes a report as a one-slide PowerPoint deck.
 *
 * The slide holds the title and two columns of section text boxes; long sections are cut to a
 * few lines and say how many lines they left out, so the slide stays readable.
 *
 * @param report - Report.
 * @param modifiedAt - Time written into the archive entries.
 * @returns `.pptx` bytes.
 */
export function createProjectStatusReportSlides(report: ProjectStatusReport, modifiedAt = new Date()): Uint8Array {
  const outline = createProjectStatusReportOutline(report)
  const leftSections = outline.sections.filter((section) => section.section === 'health' || section.section === 'progress')
  const rightSections = outline.sections.filter((section) => section.section !== 'health' && section.section !== 'progress')
  const more = report.locale === 'ja' ? (count: number) => `ほか ${count}行` : (count: number) => `${count} more lines`
  const sectionParagraphs = (sections: typeof outline.sections) => sections.flatMap((section) => {
    // Notes, such as Documents that could not be read, are always shown and never counted as left out.
    const items = section.lines.slice(0, section.lines.length - section.noteCount)
    const notes = section.lines.slice(items.length)
    const lines = items.slice(0, SLIDE_SECTION_LINE_LIMIT)
    const left = items.length - lines.length
    return [
      paragraph(section.heading, { bold: true, size: 1400 }),
      ...lines.map((line) => paragraph(line.trim(), { size: 1100, bullet: true })),
      ...(left > 0 ? [paragraph(more(left), { size: 1000, bullet: true })] : []),
      ...notes.map((line) => paragraph(line, { size: 1000, bullet: true })),
      paragraph('', { size: 600 }),
    ]
  })
  const margin = 457_200
  const titleHeight = 1_000_000
  const columnTop = margin + titleHeight
  const columnHeight = SLIDE_HEIGHT - columnTop - margin
  const gap = 228_600
  const columnWidth = (SLIDE_WIDTH - margin * 2 - gap) / 2
  const shapes = [
    textBox(2, 'Title', margin, margin, SLIDE_WIDTH - margin * 2, titleHeight, [
      paragraph(outline.title, { bold: true, size: 2400 }),
      paragraph(outline.subtitle, { size: 1200 }),
    ]),
    textBox(3, 'Left', margin, columnTop, columnWidth, columnHeight, sectionParagraphs(leftSections)),
    textBox(4, 'Right', margin + columnWidth + gap, columnTop, columnWidth, columnHeight, sectionParagraphs(rightSections)),
  ]
  const slide = `${XML_HEADER}<p:sld ${NAMESPACES}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  const encoder = new TextEncoder()
  const parts: [string, string][] = [
    ['[Content_Types].xml', `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>'],
    ['_rels/.rels', relationships([
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
    ])],
    ['docProps/core.xml', `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${escapeXml(outline.title)}</dc:title>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(report.asOf)}</dcterms:created>` +
      '</cp:coreProperties>'],
    ['docProps/app.xml', `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
      '<Application>mukuroji</Application><Slides>1</Slides></Properties>'],
    ['ppt/presentation.xml', `${XML_HEADER}<p:presentation ${NAMESPACES}>` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      '</p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', relationships([
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', 'slides/slide1.xml'],
      ['rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', 'theme/theme1.xml'],
    ])],
    ['ppt/slides/slide1.xml', slide],
    ['ppt/slides/_rels/slide1.xml.rels', relationships([
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml'],
    ])],
    ['ppt/slideLayouts/slideLayout1.xml', `${XML_HEADER}<p:sldLayout ${NAMESPACES} type="blank" preserve="1">` +
      `<p:cSld name="Blank">${emptyShapeTree()}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', '../slideMasters/slideMaster1.xml'],
    ])],
    ['ppt/slideMasters/slideMaster1.xml', `${XML_HEADER}<p:sldMaster ${NAMESPACES}>` +
      `<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyShapeTree()}</p:cSld>` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
      'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '</p:sldMaster>'],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships([
      ['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', '../theme/theme1.xml'],
    ])],
    ['ppt/theme/theme1.xml', theme()],
  ]
  return createZipArchive(parts.map(([name, xml]) => ({ name, data: encoder.encode(xml) })), modifiedAt)
}

/** Formatting of one slide paragraph. */
type ParagraphStyle = {
  /** Font size in hundredths of a point. */
  size: number
  /** Whether the text is bold. */
  bold?: boolean
  /** Whether the paragraph starts with a bullet. */
  bullet?: boolean
}

/**
 * Writes one DrawingML paragraph.
 *
 * @param text - Paragraph text.
 * @param style - Size, weight, and bullet.
 * @returns Paragraph XML.
 */
function paragraph(text: string, style: ParagraphStyle) {
  const properties = style.bullet
    ? '<a:pPr marL="171450" indent="-171450"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>'
    : '<a:pPr><a:buNone/></a:pPr>'
  const run = `<a:rPr lang="ja-JP" sz="${style.size}"${style.bold ? ' b="1"' : ''} dirty="0"/>`
  return text.length === 0
    ? `<a:p>${properties}<a:endParaRPr lang="ja-JP" sz="${style.size}"/></a:p>`
    : `<a:p>${properties}<a:r>${run}<a:t>${escapeXml(text)}</a:t></a:r></a:p>`
}

/**
 * Writes one text box shape.
 *
 * @param id - Shape ID, unique on the slide.
 * @param name - Shape name.
 * @param x - Left edge in EMU.
 * @param y - Top edge in EMU.
 * @param width - Width in EMU.
 * @param height - Height in EMU.
 * @param paragraphs - Paragraph XML.
 * @returns Shape XML.
 */
function textBox(id: number, name: string, x: number, y: number, width: number, height: number, paragraphs: readonly string[]) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(width)}" cy="${Math.round(height)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    `${paragraphs.length > 0 ? paragraphs.join('') : '<a:p/>'}</p:txBody></p:sp>`
}

/**
 * Writes the shape tree of a part without shapes.
 *
 * @returns Shape tree XML.
 */
function emptyShapeTree() {
  return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '</p:spTree>'
}

/**
 * Writes a relationships part.
 *
 * @param entries - ID, type, and target of each relationship.
 * @returns Relationships XML.
 */
function relationships(entries: readonly (readonly [string, string, string])[]) {
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
}

/**
 * Writes the theme the slide master uses, with a Japanese East Asian font.
 *
 * @returns Theme XML.
 */
function theme() {
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="1F2937"/>'],
    ['lt2', '<a:srgbClr val="F3F4F6"/>'],
    ['accent1', '<a:srgbClr val="2563EB"/>'],
    ['accent2', '<a:srgbClr val="16A34A"/>'],
    ['accent3', '<a:srgbClr val="D97706"/>'],
    ['accent4', '<a:srgbClr val="DC2626"/>'],
    ['accent5', '<a:srgbClr val="7C3AED"/>'],
    ['accent6', '<a:srgbClr val="0891B2"/>'],
    ['hlink', '<a:srgbClr val="2563EB"/>'],
    ['folHlink', '<a:srgbClr val="7C3AED"/>'],
  ].map(([name, value]) => `<a:${name}>${value}</a:${name}>`).join('')
  const font = '<a:latin typeface="Arial"/><a:ea typeface="Yu Gothic"/><a:cs typeface=""/>'
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const line = `<a:ln w="9525">${solid}</a:ln>`
  const effect = '<a:effectStyle><a:effectLst/></a:effectStyle>'
  return `${XML_HEADER}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="mukuroji">` +
    `<a:themeElements><a:clrScheme name="mukuroji">${colors}</a:clrScheme>` +
    `<a:fontScheme name="mukuroji"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="mukuroji"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>` +
    `<a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements>` +
    '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
}

/**
 * Escapes text for XML content and attribute values.
 *
 * @param text - Plain text.
 * @returns Escaped text without characters XML 1.0 forbids.
 */
function escapeXml(text: string) {
  return text
    // eslint-disable-next-line no-control-regex -- the characters XML 1.0 forbids are what this removes.
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Cuts text to the longest length a report field accepts.
 *
 * @param text - Text.
 * @param maxLength - Longest allowed length.
 * @returns Trimmed text within the limit.
 */
function clip(text: string, maxLength: number) {
  const trimmed = text.trim()
  if (trimmed.length <= maxLength) return trimmed
  // Cutting by code point keeps a surrogate pair whole, which the report contract requires.
  let clipped = ''
  for (const character of trimmed) {
    if (clipped.length + character.length > maxLength - 1) break
    clipped += character
  }
  return `${clipped}…`
}
