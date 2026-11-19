import type { DocumentBlock } from '@mukuroji/contracts'
import type { Locale } from '../../shared/i18n/i18n'

/**
 * Stable keys of the templates bundled with every Workspace.
 */
export const builtInDocumentTemplateKeys = [
  'meeting-notes',
  'design-doc',
  'retrospective',
] as const

/**
 * Key of one template bundled with every Workspace.
 */
export type BuiltInDocumentTemplateKey =
  (typeof builtInDocumentTemplateKeys)[number]

/**
 * Values substituted into a bundled template when a page is created from it.
 */
export type BuiltInDocumentTemplateVariables = {
  /** Local `YYYY-MM-DD` date the page is created for. */
  date: string
  /** Display name of the Project the page belongs to, when it has one. */
  projectName?: string
  /** Participant names, in the order the author entered them. */
  participants: string[]
}

/**
 * Page title and initial blocks produced from a bundled template.
 */
export type BuiltInDocumentTemplateContent = {
  /** Title of the new page, including the substituted date and Project. */
  title: string
  /** Initial blocks of the new page with fresh IDs. */
  blocks: DocumentBlock[]
}

/**
 * Locale-specific text of one bundled template before substitution.
 */
type TemplateBlockSpec =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'checklist'; items: string[] }

/**
 * Locale-specific source of one bundled template.
 */
type TemplateSpec = {
  /** Title pattern that may contain `{date}` and `{project}`. */
  title: string
  /** Blocks whose text may contain `{date}`, `{project}`, and `{participants}`. */
  blocks: TemplateBlockSpec[]
}

/**
 * Placeholder text used when a variable has no value.
 */
type TemplatePlaceholders = {
  /** Shown when the page has no Project. */
  project: string
  /** Shown when no participant was entered. */
  participants: string
  /** Separator between participant names. */
  participantSeparator: string
}

const placeholders: Record<Locale, TemplatePlaceholders> = {
  en: {
    participantSeparator: ', ',
    participants: '(add participants)',
    project: '(no Project)',
  },
  ja: {
    participantSeparator: '、',
    participants: '（参加者を記入）',
    project: '（Project なし）',
  },
}

const templateSpecs: Record<
  Locale,
  Record<BuiltInDocumentTemplateKey, TemplateSpec>
> = {
  en: {
    'design-doc': {
      blocks: [
        { text: 'Project: {project} / Author: {participants} / Date: {date}', type: 'paragraph' },
        { text: 'Background and goals', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Scope and non-goals', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Design', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Alternatives considered', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Risks and open questions', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: 'Design doc {project}',
    },
    'meeting-notes': {
      blocks: [
        { text: 'Date: {date}', type: 'paragraph' },
        { text: 'Project: {project}', type: 'paragraph' },
        { text: 'Participants: {participants}', type: 'paragraph' },
        { text: 'Agenda', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Decisions', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Action items', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: 'Meeting notes {date} {project}',
    },
    retrospective: {
      blocks: [
        { text: 'Date: {date} / Project: {project}', type: 'paragraph' },
        { text: 'Participants: {participants}', type: 'paragraph' },
        { text: 'Keep', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Problem', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Try', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: 'Retrospective {date} {project}',
    },
  },
  ja: {
    'design-doc': {
      blocks: [
        { text: 'Project: {project} / 作成者: {participants} / 作成日: {date}', type: 'paragraph' },
        { text: '背景と目的', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: '範囲と対象外', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: '設計', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: '検討した代替案', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'リスクと未決事項', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: '設計書 {project}',
    },
    'meeting-notes': {
      blocks: [
        { text: '日時: {date}', type: 'paragraph' },
        { text: 'Project: {project}', type: 'paragraph' },
        { text: '参加者: {participants}', type: 'paragraph' },
        { text: '議題', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: '決定事項', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: '宿題', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: '議事録 {date} {project}',
    },
    retrospective: {
      blocks: [
        { text: '日時: {date} / Project: {project}', type: 'paragraph' },
        { text: '参加者: {participants}', type: 'paragraph' },
        { text: 'Keep（続けること）', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Problem（問題）', type: 'heading' },
        { text: '', type: 'paragraph' },
        { text: 'Try（次に試すこと）', type: 'heading' },
        { items: [''], type: 'checklist' },
      ],
      title: '振り返り（KPT） {date} {project}',
    },
  },
}

/**
 * Builds the title and blocks of a new page from a bundled template.
 *
 * @param key - Bundled template to use.
 * @param locale - Language of the template text.
 * @param variables - Date, Project, and participants to substitute.
 * @param createId - Returns a fresh ID with the given prefix.
 * @returns Title and blocks for a page create request.
 */
export function buildBuiltInDocumentTemplate(
  key: BuiltInDocumentTemplateKey,
  locale: Locale,
  variables: BuiltInDocumentTemplateVariables,
  createId: (prefix: string) => string,
): BuiltInDocumentTemplateContent {
  const spec = templateSpecs[locale][key]
  const fallback = placeholders[locale]
  const projectName = variables.projectName?.trim()
  const participants = variables.participants
    .map((participant) => participant.trim())
    .filter((participant) => participant.length > 0)
  const values: Record<string, string> = {
    date: variables.date,
    participants: participants.length > 0
      ? participants.join(fallback.participantSeparator)
      : fallback.participants,
    project: projectName || fallback.project,
  }
  /**
   * Replaces every known `{name}` variable in a text.
   *
   * @param text - Template text.
   * @returns Text with variables substituted.
   */
  const substitute = (text: string) =>
    text.replace(/\{(date|participants|project)\}/g, (_match, name: string) =>
      values[name] ?? '')

  const blocks = spec.blocks.map((block): DocumentBlock => {
    if (block.type === 'heading') {
      return { id: createId('block-heading'), level: 2, text: substitute(block.text), type: 'heading' }
    }
    if (block.type === 'paragraph') {
      return { id: createId('block-paragraph'), text: substitute(block.text), type: 'paragraph' }
    }
    return {
      id: createId('block-checklist'),
      items: block.items.map((text) => ({
        checked: false,
        id: createId('check'),
        text: substitute(text),
      })),
      type: 'checklist',
    }
  })
  const title = projectName
    ? substitute(spec.title)
    : substitute(spec.title.replace(/\s*\{project\}/g, ''))

  return { blocks, title: title.trim() }
}

/**
 * Formats a date as the local `YYYY-MM-DD` calendar date.
 *
 * @param date - Instant to format in the viewer's time zone.
 * @returns Local calendar date.
 */
export function formatLocalCalendarDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Splits participant text typed as a comma or newline separated list.
 *
 * @param value - Raw participant text.
 * @returns Non-empty participant names.
 */
export function parseTemplateParticipants(value: string): string[] {
  return value
    .split(/[,、，\n]/)
    .map((participant) => participant.trim())
    .filter((participant) => participant.length > 0)
}
