import { splitDocumentPageLinks } from '@mukuroji/contracts'

/**
 * Props of stored text that may hold links to other pages.
 */
export type DocumentLinkedTextProps = {
  /** Stored paragraph, cell, or checklist item text. */
  text: string
}

/**
 * Shows stored text with `[label](/documents/<id>)` links, such as those a
 * Markdown folder import writes, as links to those pages.
 *
 * @param props - Text to show.
 * @returns The text with clickable page links.
 */
export function DocumentLinkedText({ text }: DocumentLinkedTextProps) {
  const segments = splitDocumentPageLinks(text)
  if (segments.length === 1 && segments[0]?.type === 'text') return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <a
            className="font-semibold text-[var(--workbench-primary-text)] underline"
            href={segment.href}
            key={index}
          >
            {segment.label}
          </a>
        ),
      )}
    </>
  )
}
