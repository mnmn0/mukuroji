import type { AiAssistanceCitation, AiSummaryDraft } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Maximum UTF-16 length accepted by the curated context editor. */
const collaborationContextBodyMaximumLength = 20_000
/** Maximum length of one evidence line while preserving complete citation links. */
const collaborationContextEvidenceLineMaximumLength = 12_000

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
  let omittedEvidence = false

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
    const firstEvidence = evidence[0]
    if (firstEvidence !== undefined) {
      let evidenceLine = `  ${t('ai.summary.evidence')}: ${firstEvidence}`
      for (const nextEvidence of evidence.slice(1)) {
        const candidate = `${evidenceLine}, ${nextEvidence}`
        if (candidate.length > collaborationContextEvidenceLineMaximumLength) {
          omittedEvidence = true
          break
        }
        evidenceLine = candidate
      }
      lines.push(evidenceLine)
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
  return boundContextBody(
    lines,
    evidenceLineIndices,
    t('ai.summary.contextTruncated'),
    omittedEvidence,
  )
}

/**
 * Bounds the fully formatted body while keeping each included claim and evidence pair intact.
 *
 * A claim is never cut in the middle of a sentence. When the complete body does not fit, whole
 * claim/evidence units are omitted and a localized note is appended so the curator knows the
 * editor contains an intentionally incomplete draft.
 *
 * @param lines - Formatted claim, evidence, heading, and separator lines.
 * @param evidenceLineIndices - Line indices that contain complete citation links.
 * @param truncationNotice - Localized note shown when one or more complete lines are omitted.
 * @param contentWasOmitted - Whether citation links were omitted before the body-size check.
 * @returns A body within the editor limit with no claim detached from its evidence.
 */
function boundContextBody(
  lines: readonly string[],
  evidenceLineIndices: ReadonlySet<number>,
  truncationNotice: string,
  contentWasOmitted = false,
): string {
  const units: string[][] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    const evidenceLine = evidenceLineIndices.has(index + 1) ? lines[index + 1] : undefined
    if (evidenceLine !== undefined) {
      units.push([line, evidenceLine])
      index += 1
      continue
    }

    units.push([line])
  }

  const completeBody = units.map((unit) => unit.join('\n')).join('\n')
  if (completeBody.length <= collaborationContextBodyMaximumLength && !contentWasOmitted) {
    return completeBody
  }

  // Reserve space for the notice before selecting units so that the notice itself can never
  // force a previously complete claim to be cut or detached from its evidence.
  const notice = truncateToUtf16Boundary(
    truncationNotice,
    collaborationContextBodyMaximumLength,
  )
  const bodyMaximumLength = Math.max(
    0,
    collaborationContextBodyMaximumLength - notice.length - 2,
  )
  let body = ''
  let omitted = contentWasOmitted
  for (const unit of units) {
    const chunk = unit.join('\n')
    const separator = body ? '\n' : ''
    if (body.length + separator.length + chunk.length <= bodyMaximumLength) {
      body += `${separator}${chunk}`
    } else {
      omitted = true
    }
  }

  if (!omitted) return body
  const noticeSeparator = body ? '\n\n' : ''
  const availableNoticeLength = collaborationContextBodyMaximumLength - body.length - noticeSeparator.length
  const boundedNotice = truncateToUtf16Boundary(notice, Math.max(0, availableNoticeLength))
  return `${body}${noticeSeparator}${boundedNotice}`
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
