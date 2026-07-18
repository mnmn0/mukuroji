import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  publicRequestFormFixture,
  requestSubmissionReceiptFixture,
} from '../src/requests/fixtures'
import { normalizePublicRequestForm } from '../src/requests/model'
import { PublicRequestFormScreen } from '../src/requests/PublicRequestFormPage'

test('uses custom trimmed validation without conflicting native text constraints', () => {
  const form = normalizePublicRequestForm(publicRequestFormFixture)
  const section = form.sections[0]
  if (!section) throw new Error('Public request fixture needs a section.')
  const email = section.fields.find((field) => field.id === 'requester-email')
  const summary = section.fields.find((field) => field.id === 'summary')
  if (!email || !summary) throw new Error('Public request fixture needs text fields.')

  email.validation = {
    maxLength: 100,
    minLength: 3,
    pattern: '^[^@]+@[^@]+$',
  }
  summary.validation = {
    maxLength: 2_000,
    minLength: 8,
    pattern: '^.+$',
  }
  section.fields.push(
    {
      description: {},
      id: 'reference-url',
      label: { ja: '参照URL' },
      options: [],
      placeholder: {},
      required: false,
      type: 'url',
      validation: { maxLength: 200, pattern: '^https://' },
    },
    {
      description: {},
      id: 'requested-date',
      label: { ja: '希望日' },
      options: [],
      placeholder: {},
      required: false,
      type: 'date',
    },
  )

  const html = renderToStaticMarkup(
    <PublicRequestFormScreen
      form={form}
      locale="ja"
      onLocaleChange={() => undefined}
      onSubmit={async () => requestSubmissionReceiptFixture}
    />,
  )

  const emailTag = getOpeningTag(html, 'public-request-field-requester-email')
  expect(emailTag).toContain('type="text"')
  expect(emailTag).toContain('inputMode="email"')
  expect(emailTag).not.toMatch(/\s(?:minLength|maxLength|pattern)=/u)

  const summaryTag = getOpeningTag(html, 'public-request-field-summary')
  expect(summaryTag.startsWith('<textarea')).toBe(true)
  expect(summaryTag).not.toMatch(/\s(?:minLength|maxLength|pattern)=/u)

  expect(getOpeningTag(html, 'public-request-field-reference-url')).toContain('type="url"')
  expect(getOpeningTag(html, 'public-request-field-requested-date')).toContain('type="date"')
})

function getOpeningTag(html: string, testId: string) {
  const marker = `data-testid="${testId}"`
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing element with test ID "${testId}".`)
  const tagStart = html.lastIndexOf('<', markerIndex)
  const tagEnd = html.indexOf('>', markerIndex)
  return html.slice(tagStart, tagEnd + 1)
}
