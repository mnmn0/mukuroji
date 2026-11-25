import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { referoTaskFixtures } from '../src/tasks/fixtures'
import { resolveAgentReadyTransition, type AgentReadySettings } from '../src/work-items/model/agentReadyTransition'
import { AgentReadyAction } from '../src/work-items/ui/AgentReadyAction'
import { teamWorkItemConfigurationFixture } from '../src/work-items/fixtures'

const t = createTranslator('en')
const backlogTask = {
  ...referoTaskFixtures[0],
  workflowStatusId: 'backlog',
  statusCategory: 'backlog' as const,
  workItemTypeId: undefined,
  acceptanceCriteria: [{ id: 'c1', text: 'Works on mobile', satisfied: false }],
  relationIds: [],
}
const settings: AgentReadySettings = { readyStatusIds: ['ready'], requireAcceptanceCriteria: true }
const configuration = teamWorkItemConfigurationFixture

describe('agent ready transition', () => {
  test('moves a backlog task to the Ready status that the workflow allows', () => {
    const result = resolveAgentReadyTransition({ task: backlogTask, settings, configuration, hasActiveRun: false })
    expect(result).toEqual({ kind: 'canMove', status: expect.objectContaining({ id: 'ready', name: 'Ready' }) })
  })

  test('reports a task already in a Ready status as a candidate', () => {
    const task = { ...backlogTask, workflowStatusId: 'ready', statusCategory: 'unstarted' as const }
    expect(resolveAgentReadyTransition({ task, settings, configuration, hasActiveRun: false })).toEqual({ kind: 'alreadyReady' })
  })

  test('treats any backlog or unstarted status as a candidate when no Ready status is chosen', () => {
    const result = resolveAgentReadyTransition({
      task: backlogTask,
      settings: { readyStatusIds: [], requireAcceptanceCriteria: false },
      configuration,
      hasActiveRun: false,
    })
    expect(result).toEqual({ kind: 'alreadyReady' })
  })

  test('lists every reason a status change alone cannot fix', () => {
    const task = { ...backlogTask, workflowStatusId: 'active', statusCategory: 'started' as const, acceptanceCriteria: [] }
    expect(resolveAgentReadyTransition({ task, settings, configuration, hasActiveRun: true })).toEqual({
      kind: 'blocked',
      reasons: ['started', 'activeRun', 'noAcceptanceCriteria'],
    })
    const closed = { ...backlogTask, workflowStatusId: 'done', statusCategory: 'completed' as const }
    expect(resolveAgentReadyTransition({ task: closed, settings, configuration, hasActiveRun: false })).toEqual({ kind: 'blocked', reasons: ['closed'] })
  })

  test('accepts criteria kept in the configured custom field', () => {
    const task = { ...backlogTask, acceptanceCriteria: [], customFieldValues: { 'definition-of-done': 'Reviewed' } }
    const result = resolveAgentReadyTransition({
      task,
      settings: { ...settings, acceptanceCriteriaFieldId: 'definition-of-done' },
      configuration,
      hasActiveRun: false,
    })
    expect(result.kind).toBe('canMove')
  })

  test('explains when no workflow transition reaches a Ready status', () => {
    const result = resolveAgentReadyTransition({
      task: backlogTask,
      settings: { ...settings, readyStatusIds: ['review'] },
      configuration,
      hasActiveRun: false,
    })
    expect(result).toEqual({ kind: 'blocked', reasons: ['noTransition'] })
  })
})

describe('agent ready action', () => {
  test('offers the action only to viewers who can edit the task', () => {
    const props = {
      task: backlogTask,
      configuration,
      settings: { status: 'loaded' as const, value: settings },
      activeRun: { status: 'loaded' as const, value: false },
      t,
    }
    const editable = renderToStaticMarkup(<AgentReadyAction {...props} onMoveToStatus={async () => undefined} />)
    expect(editable).toContain('Make ready for agents')
    expect(editable).toContain('Moving it to “Ready” lets agents start it.')
    expect(renderToStaticMarkup(<AgentReadyAction {...props} />)).not.toContain('Make ready for agents')
  })

  test('notes open blockers that keep the task out of the candidates', () => {
    const html = renderToStaticMarkup(<AgentReadyAction
      activeRun={{ status: 'loaded', value: false }}
      configuration={configuration}
      settings={{ status: 'loaded', value: settings }}
      t={t}
      task={{ ...backlogTask, relationIds: ['blockedBy:other'] }}
    />)
    expect(html).toContain('The task has 1 blockedBy relations.')
  })

  test('says the state is unknown when settings or runs cannot be read', () => {
    const html = renderToStaticMarkup(<AgentReadyAction
      activeRun={{ status: 'unavailable' }}
      configuration={configuration}
      settings={{ status: 'loaded', value: settings }}
      t={t}
      task={backlogTask}
    />)
    expect(html).toContain('Agent settings or agent runs could not be loaded.')
    expect(html).not.toContain('Make ready for agents')
  })
})
