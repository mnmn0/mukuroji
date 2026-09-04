import { describe, expect, test } from 'bun:test'
import type {
  CustomFieldDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_TYPE } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WorkItemConfigurationPanel,
  WorkItemTypesConfigurationSection,
  WorkflowConfigurationSection,
} from '../src/work-items/ui/WorkItemConfigurationPanel'
import { WorkItemFieldsEditor } from '../src/work-items/ui/WorkItemFieldsEditor'
import { workspaceWorkItemConfigurationFixture } from '../src/work-items/fixtures'
import { normalizeWorkItemConfigurationForSave } from '../src/work-items/model/workItemConfigurationEditor'

describe('Work Item editors', () => {
  test('keeps label and input IDs distinct for every valid custom field ID', () => {
    const definitions = [
      createCustomFieldDefinition('risk.level', 'Dot field', 0),
      createCustomFieldDefinition('risk-level', 'Hyphen field', 1),
    ]
    const html = renderToStaticMarkup(
      <WorkItemFieldsEditor definitions={definitions} locale="en" />,
    )
    const dotFieldId = 'work-item-field-a-007200690073006b002e006c006500760065006c'
    const hyphenFieldId = 'work-item-field-a-007200690073006b002d006c006500760065006c'

    expect(dotFieldId).not.toBe(hyphenFieldId)
    expect(html).toContain(`for="${dotFieldId}"`)
    expect(html).toContain(`id="${dotFieldId}"`)
    expect(html).toContain(`for="${hyphenFieldId}"`)
    expect(html).toContain(`id="${hyphenFieldId}"`)
  })

  test('normalizes select options in the same order shown by the editor', () => {
    const configuration = createConfiguration([
      {
        id: 'release-stage',
        name: 'Release stage',
        options: [
          { id: 'released', name: ' Released ', sortOrder: 2 },
          { id: 'planned', name: ' Planned ', sortOrder: 0 },
          { id: 'active', name: ' Active ', sortOrder: 1 },
        ],
        required: false,
        sortOrder: 0,
        type: 'select',
      },
    ])

    expect(normalizeWorkItemConfigurationForSave(configuration).customFields[0]?.options)
      .toEqual([
        { id: 'planned', name: 'Planned', sortOrder: 0 },
        { id: 'active', name: 'Active', sortOrder: 1 },
        { id: 'released', name: 'Released', sortOrder: 2 },
      ])
    expect(configuration.customFields[0]?.options?.map((option) => option.id))
      .toEqual(['released', 'planned', 'active'])
  })

  test('removes deleted custom fields from Work Item Type references before saving', () => {
    const configuration = createConfiguration([
      createCustomFieldDefinition('risk', 'Risk', 0),
    ])
    const normalized = normalizeWorkItemConfigurationForSave({
      ...configuration,
      workItemTypes: [{
        ...DEFAULT_WORK_ITEM_TYPE,
        defaultWorkflowId: configuration.workflow.id,
        id: 'incident',
        customFieldIds: ['risk', 'deleted-field'],
        requiredCustomFieldIds: ['risk', 'deleted-field'],
      }],
    })

    expect(normalized.workItemTypes?.[0]?.customFieldIds).toEqual(['risk'])
    expect(normalized.workItemTypes?.[0]?.requiredCustomFieldIds).toEqual(['risk'])
  })

  test('normalizes Work Item Types in their existing administration order', () => {
    const configuration = createConfiguration([])
    const normalized = normalizeWorkItemConfigurationForSave({
      ...configuration,
      workItemTypes: [
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          id: 'incident',
          name: 'Incident',
          sortOrder: 20,
        },
        {
          ...DEFAULT_WORK_ITEM_TYPE,
          id: 'request',
          name: 'Request',
          sortOrder: 10,
        },
      ],
    })

    expect(normalized.workItemTypes?.map(({ id, sortOrder }) => ({ id, sortOrder }))).toEqual([
      { id: 'request', sortOrder: 0 },
      { id: 'incident', sortOrder: 1 },
    ])
  })

  test('keeps globally required fields required in every type checklist', () => {
    const configuration = createConfiguration([{
      ...createCustomFieldDefinition('global-required', 'Global required', 0),
      required: true,
    }])
    const html = renderToStaticMarkup(
      <WorkItemTypesConfigurationSection
        configuration={{
          ...configuration,
          workItemTypes: [{
            ...DEFAULT_WORK_ITEM_TYPE,
            customFieldIds: ['global-required'],
            defaultWorkflowId: configuration.workflow.id,
            requiredCustomFieldIds: [],
          }],
        }}
        locale="en"
        onChange={() => undefined}
      />,
    )

    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"[^>]*checked=""/u)
  })

  test('allows decimal defaults for every numeric custom field type', () => {
    const configuration = createConfiguration([
      {
        ...createCustomFieldDefinition('score', 'Score', 0),
        defaultValue: 1.5,
        type: 'number',
      },
      {
        ...createCustomFieldDefinition('budget', 'Budget', 1),
        currencyCode: 'USD',
        defaultValue: 2.25,
        type: 'currency',
      },
      {
        ...createCustomFieldDefinition('estimate', 'Estimate', 2),
        defaultValue: 0.75,
        durationUnit: 'hours',
        type: 'duration',
      },
    ])
    const html = renderToStaticMarkup(
      <WorkItemConfigurationPanel
        configuration={configuration}
        locale="en"
        onScopeChange={() => undefined}
        readOnly
        scopeOptions={[{ label: 'Workspace', value: 'workspace' }]}
        selectedScopeValue="workspace"
      />,
    )

    expect(html).toContain('step="any" type="number" value="1.5"')
    expect(html).toContain('step="any" type="number" value="2.25"')
    expect(html).toContain('step="any" type="number" value="0.75"')
  })

  test('renders a selector for additional workflows', () => {
    const secondaryWorkflow = {
      id: 'incident-workflow',
      name: 'Incident workflow',
      initialStatusId: 'reported',
      statuses: [{
        category: 'backlog' as const,
        id: 'reported',
        name: 'Reported',
        sortOrder: 0,
      }],
      transitions: [],
    }
    const configuration = createConfiguration([])
    const html = renderToStaticMarkup(
      <WorkflowConfigurationSection
        configuration={{ ...configuration, workflows: [secondaryWorkflow] }}
        locale="en"
        onChange={() => undefined}
      />,
    )

    expect(html).toContain('Workflow to edit')
    expect(html).toContain('Incident workflow')
    expect(html).toContain('value="incident-workflow"')
    expect(html).toContain('Add workflow')
  })
})

function createCustomFieldDefinition(
  id: string,
  name: string,
  sortOrder: number,
): CustomFieldDefinition {
  return {
    id,
    name,
    required: false,
    sortOrder,
    type: 'text',
  }
}

function createConfiguration(
  customFields: CustomFieldDefinition[],
): WorkItemConfiguration {
  return {
    ...workspaceWorkItemConfigurationFixture,
    customFields,
    workflow: {
      ...workspaceWorkItemConfigurationFixture.workflow,
      statuses: workspaceWorkItemConfigurationFixture.workflow.statuses.map((status) => ({
        ...status,
      })),
      transitions: workspaceWorkItemConfigurationFixture.workflow.transitions.map((transition) => ({
        ...transition,
      })),
    },
  }
}
