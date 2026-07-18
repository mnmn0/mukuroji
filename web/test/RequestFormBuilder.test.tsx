import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { requestFormFixture } from '../src/requests/fixtures'
import {
  normalizeRequestForm,
  synchronizeRequestRoutingTeam,
} from '../src/requests/model'
import { RequestFormBuilder } from '../src/requests/RequestFormBuilder'

describe('RequestFormBuilder', () => {
  test('disables the complete builder while a mutation is pending', () => {
    const html = renderToStaticMarkup(
      <RequestFormBuilder
        isSaving
        locale="ja"
        model={normalizeRequestForm(requestFormFixture)}
        teams={projectDirectoryFixtures}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    const controls = getOpeningTag(html, 'request-form-builder-controls')
    expect(controls).toContain('disabled=""')
  })

  test('keeps publishing available to a publish-only principal', () => {
    const html = renderToStaticMarkup(
      <RequestFormBuilder
        canEdit={false}
        canPublish
        locale="ja"
        model={normalizeRequestForm(requestFormFixture)}
        teams={projectDirectoryFixtures}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(getOpeningTag(html, 'request-form-builder-controls')).not.toContain('disabled=""')
    expect(getOpeningTag(html, 'request-form-builder-edit-controls')).toContain('disabled=""')
    expect(getOpeningTag(html, 'request-form-builder-save')).toContain('disabled=""')
    expect(getOpeningTag(html, 'request-form-builder-publish')).not.toContain('disabled=""')
  })

  test('locks default and rule Team controls for a Team-scoped form', () => {
    const model = normalizeRequestForm(requestFormFixture)
    model.scope = { type: 'team', teamId: 'core-team' }
    model.routing = synchronizeRequestRoutingTeam(model.routing, 'core-team')

    const html = renderToStaticMarkup(
      <RequestFormBuilder
        locale="ja"
        model={model}
        teams={projectDirectoryFixtures}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(getOpeningTag(html, 'request-routing-default-team')).toContain('disabled=""')
    expect(getOpeningTag(html, 'request-routing-rule-team')).toContain('disabled=""')
  })
})

function getOpeningTag(html: string, testId: string) {
  const marker = `data-testid="${testId}"`
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing element with test ID "${testId}".`)
  const tagStart = html.lastIndexOf('<', markerIndex)
  const tagEnd = html.indexOf('>', markerIndex)
  return html.slice(tagStart, tagEnd + 1)
}
