import type { AiAssistanceCitation, AiSummaryDraft } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Maximum UTF-16 length accepted by the curated context editor. */
const collaborationContextBodyMaximumLength = 20_000

/**
 * Formats an approved summary as an editable context draft without persisting it.
 *
 * @param draft - Currently authorized summary returned after approval.
 * @param citations - Permission-safe citations returned with the approved draft.
 * @param t - Localized label resolver.
 * @returns Markdown-like plain text for the existing human-owned editor.
 */
export function formatAiSummaryContextBody(
  draft: AiSummaryDraft,
  citations: readonly AiAssistanceCitation[],
  t: (key: MessageKey) => string,
): string {
  const citationById = new Map(citations.map((citation) => [citation.id, citation]))
  const lines: string[] = []
  const evidenceLineIndices = new Set<number>()

  /** Appends one claim and its complete evidence line to the formatted body. */
  const appendItem = (item: AiSummaryDraft['overview'], marker: string): void => {
    lines.push(`${marker}${escapeMarkdownText(item.text)}`)
    const evidence = item.citationIds
      .map((citationId) => citationById.get(citationId))
      .filter((citation): citation is AiAssistanceCitation => citation !== undefined)
      .map((citation) => {
        const label = citation.label.replace(/[\\[\]]/gu, '\\$&')
        return `[${label}](<${escapeMarkdownLinkDestination(citation.href)}>)`
      })
    if (evidence.length > 0) {
      lines.push(`  ${t('ai.summary.evidence')}: ${evidence.join(', ')}`)
      evidenceLineIndices.add(lines.length - 1)
    }
  }
  const sections = [
    [t('ai.summary.decisions'), draft.decisions],
    [t('ai.summary.actions'), draft.actions],
    [t('ai.summary.risks'), draft.risks],
  ] as const
  appendItem(draft.overview, '')
  for (const [title, items] of sections) {
    if (items.length === 0) continue
    lines.push('', `## ${title}`)
    for (const item of items) appendItem(item, '- ')
  }
  return boundContextBody(lines, evidenceLineIndices)
}

/**
 * Bounds the fully formatted body while keeping each included claim's evidence line intact.
 *
 * @param lines - Formatted claim, evidence, heading, and separator lines.
 * @param evidenceLineIndices - Line indices that contain complete citation links.
 * @returns A body within the editor limit with no claim detached from its evidence.
 */
function boundContextBody(
  lines: readonly string[],
  evidenceLineIndices: ReadonlySet<number>,
): string {
  let body = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    const separator = body ? '\n' : ''
    const remainingLength = collaborationContextBodyMaximumLength - body.length - separator.length
    if (remainingLength <= 0) break

    const evidenceLine = evidenceLineIndices.has(index + 1) ? lines[index + 1] : undefined
    if (evidenceLine !== undefined) {
      const pairLength = line.length + 1 + evidenceLine.length
      if (pairLength <= remainingLength) {
        body += `${separator}${line}\n${evidenceLine}`
        index += 1
        continue
      }

      const claimLength = remainingLength - 1 - evidenceLine.length
      if (claimLength > 0) {
        const truncatedClaim = truncateToUtf16Boundary(line, claimLength)
        if (truncatedClaim.length > 0) {
          body += `${separator}${truncatedClaim}\n${evidenceLine}`
        }
      }
      break
    }

    if (line.length <= remainingLength) {
      body += `${separator}${line}`
      continue
    }
    if (!body) return truncateToUtf16Boundary(line, remainingLength)
    break
  }
  return body
}

/**
 * Truncates one generated line without leaving a dangling UTF-16 high surrogate.
 *
 * @param value - Generated line to bound.
 * @param maximumLength - Maximum UTF-16 code-unit length.
 * @returns The bounded line with a complete final code point.
 */
function truncateToUtf16Boundary(value: string, maximumLength: number): string {
  const truncated = value.slice(0, maximumLength)
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated
}

/**
 * Escapes generated prose before it enters the existing Markdown-backed editor.
 *
 * @param text - Generated claim text to place in a Markdown body.
 * @returns Text with Markdown control characters escaped.
 */
function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]{}()#+.!|>~-]/gu, '\\$&')
}

/**
 * Encodes Markdown destination delimiters while preserving application routing.
 *
 * @param href - Permission-safe application path used as the link destination.
 * @returns A destination that cannot terminate or reshape the Markdown link.
 */
function escapeMarkdownLinkDestination(href: string): string {
  return href.replace(/[()<>\\\s]/gu, (character) => encodeURIComponent(character))
}
