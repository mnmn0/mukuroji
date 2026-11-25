import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SafeCommentBody } from '../src/issues/ui/SafeCommentBody'
import { SafeMarkdown } from '../src/shared/ui/SafeMarkdown'

/** Body that two blocks or comments on one page both write, with the same footnote label. */
const FOOTNOTE_BODY = 'See this[^n].\n\n[^n]: The note.'

/** Footnote links and targets of one rendered Markdown body. */
type FootnoteLinks = {
  /** `href` of the reference link, which points at the footnote. */
  referenceHref: string
  /** `id` of the reference link. */
  referenceId: string
  /** `id` of the footnote item. */
  footnoteId: string
  /** `href` of the back link, which points at the reference. */
  backHref: string
  /** `id` of the footnote heading. */
  labelId: string
  /** `aria-describedby` of the reference link, which names the heading. */
  referenceDescribedBy: string
}

/**
 * Renders a page and returns the HTML of each element marked as one Markdown body.
 *
 * @param page - Elements of the page, each wrapped in an `article`.
 * @returns The HTML of each `article`, in page order.
 */
function renderSections(page: ReactNode) {
  return [...renderToStaticMarkup(page).matchAll(/<article>(.*?)<\/article>/gsu)].map((match) => match[1] ?? '')
}

/**
 * Reads the footnote links and targets of one rendered Markdown body.
 *
 * @param html - HTML of the body.
 * @returns Its footnote links and targets.
 */
function readFootnoteLinks(html: string): FootnoteLinks {
  const reference = /<a([^>]*data-footnote-ref[^>]*)>/u.exec(html)?.[1] ?? ''
  const back = /<a([^>]*data-footnote-backref[^>]*)>/u.exec(html)?.[1] ?? ''
  return {
    backHref: /href="([^"]*)"/u.exec(back)?.[1] ?? '',
    footnoteId: /<li id="([^"]*)"/u.exec(html)?.[1] ?? '',
    labelId: /<h2[^>]*id="([^"]*)"/u.exec(html)?.[1] ?? '',
    referenceDescribedBy: /aria-describedby="([^"]*)"/u.exec(reference)?.[1] ?? '',
    referenceHref: /href="([^"]*)"/u.exec(reference)?.[1] ?? '',
    referenceId: /id="([^"]*)"/u.exec(reference)?.[1] ?? '',
  }
}

/**
 * Checks that each body's footnote links point at its own targets, and that no two bodies share
 * an id.
 *
 * @param sections - HTML of each body on one page.
 */
function expectOwnFootnotes(sections: string[]) {
  expect(sections).toHaveLength(2)
  const links = sections.map(readFootnoteLinks)
  for (const link of links) {
    expect(link.footnoteId).not.toBe('')
    expect(link.referenceId).not.toBe('')
    expect(link.referenceHref).toBe(`#${link.footnoteId}`)
    expect(link.backHref).toBe(`#${link.referenceId}`)
    expect(link.labelId).not.toBe('')
    expect(link.referenceDescribedBy).toBe(link.labelId)
  }
  const [first, second] = links
  expect(first?.footnoteId).not.toBe(second?.footnoteId)
  expect(first?.referenceId).not.toBe(second?.referenceId)
  expect(first?.labelId).not.toBe(second?.labelId)
}

describe('Markdown footnotes on a page with several bodies', () => {
  test('links each Document block to its own footnote when two blocks use the same label', () => {
    const sections = renderSections(
      <>
        <article><SafeMarkdown bodyMarkdown={FOOTNOTE_BODY} rawHtml="escape" /></article>
        <article><SafeMarkdown bodyMarkdown={FOOTNOTE_BODY} rawHtml="escape" /></article>
      </>,
    )

    expectOwnFootnotes(sections)
    expect(sections[0]).not.toContain('target="_blank"')
  })

  test('links each comment to its own footnote when two comments use the same label', () => {
    const sections = renderSections(
      <>
        <article><SafeCommentBody bodyMarkdown={FOOTNOTE_BODY} /></article>
        <article><SafeCommentBody bodyMarkdown={FOOTNOTE_BODY} /></article>
      </>,
    )

    expectOwnFootnotes(sections)
  })

  test('gives a reused label and a label named like its reuse their own reference ids', () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown bodyMarkdown={'A[^a], again[^a], B[^a-2]\n\n[^a]: First.\n\n[^a-2]: Second.'} rawHtml="escape" />,
    )
    const referenceIds = [...html.matchAll(/<a[^>]*data-footnote-ref[^>]*>/gu)]
      .map((match) => /id="([^"]*)"/u.exec(match[0])?.[1] ?? '')
    expect(referenceIds).toHaveLength(3)
    expect(new Set(referenceIds).size).toBe(3)
    // Each back link points at a reference of its own footnote.
    const backHrefs = [...html.matchAll(/<a[^>]*data-footnote-backref[^>]*>/gu)]
      .map((match) => /href="#([^"]*)"/u.exec(match[0])?.[1] ?? '')
    expect(backHrefs).toEqual([referenceIds[0], referenceIds[1], referenceIds[2]])
  })

  test('shows the title of a link', () => {
    expect(renderToStaticMarkup(<SafeMarkdown bodyMarkdown={'[Steps](https://example.com "For admins")'} rawHtml="escape" />))
      .toContain('title="For admins"')
  })
})
