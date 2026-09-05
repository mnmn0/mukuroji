import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORK_ITEM_TYPE, type WorkItemConfiguration } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { requestFormFixture } from '../src/requests/fixtures'
import {
  normalizeRequestForm,
  synchronizeRequestRoutingTeam,
} from '../src/requests/model/requestForm'
import { RequestFormBuilder } from '../src/requests/ui/RequestFormBuilder'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

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

  test('resolves routing statuses from the selected Work Item Type workflow', () => {
    const configuration = {
      ...teamWorkItemConfigurationFixture,
      workflows: [{
        id: 'incident-workflow',
        name: 'Incident workflow',
        initialStatusId: 'incident-open',
        statuses: [{
          id: 'incident-open',
          name: 'Open',
          category: 'unstarted',
          sortOrder: 0,
        }],
        transitions: [],
      }],
      workItemTypes: [{
        ...DEFAULT_WORK_ITEM_TYPE,
        defaultWorkflowId: teamWorkItemConfigurationFixture.workflow.id,
      }, {
        ...DEFAULT_WORK_ITEM_TYPE,
        id: 'incident',
        name: 'Incident',
        defaultWorkflowId: 'incident-workflow',
        sortOrder: 10,
      }],
    } satisfies WorkItemConfiguration
    const model = normalizeRequestForm(requestFormFixture)
    model.routing.workItemTypeId = 'incident'
    model.routing.workflowStatusId = 'incident-open'
    const html = renderToStaticMarkup(
      <RequestFormBuilder
        locale="ja"
        model={model}
        teams={projectDirectoryFixtures}
        workItemConfigurationsByTeam={{ 'core-team': configuration }}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    )

    expect(html).toContain('<option value="incident-open" selected="">Open</option>')
    expect(html).toContain('<option value="incident" selected="">Incident</option>')
    expect(html).not.toContain('<option value="backlog">Backlog</option>')
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
