import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { requestSubmissionFixture } from '../src/requests/fixtures'
import { normalizeRequestSubmission } from '../src/requests/model/requestForm'
import { RequestQueue } from '../src/requests/ui/RequestQueue'

describe('RequestQueue', () => {
  test('renders historical select labels and exposes a focusable detail control', () => {
    const submission = normalizeRequestSubmission(requestSubmissionFixture)
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="en"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>Bug</dd>')
    expect(html).not.toContain('>bug</dd>')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('aria-label="Open request details: プロダクトサポート依頼 v1"')
  })

  test('renders every known multi-select option label and preserves unknown legacy values', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      answers: {
        ...requestSubmissionFixture.answers,
        'request-kind': ['bug', 'legacy-option'],
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).toContain('>不具合, legacy-option</dd>')
  })

  test('does not expose duplicate-candidate actions without the capability', () => {
    const submission = normalizeRequestSubmission({
      ...requestSubmissionFixture,
      capabilities: {
        ...requestSubmissionFixture.capabilities,
        canMarkDuplicate: false,
      },
    })
    const html = renderToStaticMarkup(
      <RequestQueue
        locale="ja"
        selectedSubmission={submission}
        submissions={[submission]}
        onSelectSubmission={() => undefined}
      />,
    )

    expect(html).not.toContain('submission-previous')
  })
})
