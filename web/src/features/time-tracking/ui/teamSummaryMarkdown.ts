import { WEEKLY_SUMMARY_SECTION_NAMES } from '@mukuroji/contracts'
import { describeTeamSummaryItem, TEAM_SUMMARY_SECTION_TITLES, type TeamSummaryContent } from './TeamWeeklySummary'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'

/**
 * Formats a Team weekly or monthly summary as Markdown, so it can be pasted into a Planning
 * update, a Document, or a chat message. It holds only what the reader's summary holds, so it
 * never carries a Work Item the reader may not read.
 *
 * @param summary - Summary read from the server.
 * @param heading - First heading, such as the Team and the period.
 * @param projectNames - Project names keyed by Project ID.
 * @param t - Translator.
 * @param formatters - Date formatters.
 * @returns Markdown text ending with a newline.
 */
export function formatTeamSummaryMarkdown(
  summary: TeamSummaryContent,
  heading: string,
  projectNames: Readonly<Record<string, string>>,
  t: TimeTrackingTranslator,
  formatters: TimeTrackingFormatters,
): string {
  const lines = [`# ${escapeMarkdown(heading)}`, '']
  for (const name of WEEKLY_SUMMARY_SECTION_NAMES) {
    const previous = summary.previousTotals
      ? ` (${t('timeTracking.monthlySummary.previous').replace('{count}', String(summary.previousTotals[name]))})`
      : ''
    lines.push(`- ${t(TEAM_SUMMARY_SECTION_TITLES[name])}: ${summary.totals[name]}${previous}`)
  }
  for (const scope of summary.scopes) {
    const title = scope.projectId === undefined
      ? t('timeTracking.weeklySummary.noProject')
      : projectNames[scope.projectId] ?? scope.projectId
    lines.push('', `## ${escapeMarkdown(title)}`)
    for (const name of WEEKLY_SUMMARY_SECTION_NAMES) {
      const section = scope[name]
      lines.push('', `### ${t(TEAM_SUMMARY_SECTION_TITLES[name])} (${section.count})`, '')
      if (section.count === 0) {
        lines.push(name === 'delayed' && scope.baseline === null
          ? t('timeTracking.weeklySummary.delayedNoBaseline')
          : t('timeTracking.weeklySummary.none'))
        continue
      }
      for (const item of section.items) {
        const label = `${item.key ? `${item.key} ` : ''}${item.title}`
        const detail = describeTeamSummaryItem(name, item, t, formatters)
        lines.push(`- ${escapeMarkdown(label)}${detail ? ` (${detail})` : ''}`)
      }
      if (section.count > section.items.length) {
        lines.push(`- ${t('timeTracking.weeklySummary.more').replace('{count}', String(section.count - section.items.length))}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Escapes characters that would turn a title into Markdown markup.
 *
 * @param text - Plain text.
 * @returns Text safe inside a Markdown line.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>#|]/gu, (character) => `\\${character}`).replace(/\s+/gu, ' ')
}
