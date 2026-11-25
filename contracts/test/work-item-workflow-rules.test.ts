import { expect, test } from 'bun:test'
import {
  evaluateWorkflowStatusRequirements,
  evaluateWorkflowTransitionActor,
  findWorkflowEntryActorRoles,
  type WorkflowRuleActor,
} from '../src/work-item-workflow-rules'

const workflow = {
  transitions: [
    { fromStatusId: 'todo', toStatusId: 'review' },
    { fromStatusId: 'review', toStatusId: 'approved', allowedActorRoles: ['project-manager' as const] },
    { fromStatusId: 'todo', toStatusId: 'approved', allowedActorRoles: ['assignee' as const] },
  ],
}

const member: WorkflowRuleActor = { interactive: true, projectManager: false, assignee: false }

test('uses a known transition’s roles and leaves an unrestricted one open', () => {
  expect(findWorkflowEntryActorRoles(workflow, 'review', 'approved')).toEqual(['project-manager'])
  expect(findWorkflowEntryActorRoles(workflow, 'todo', 'review')).toEqual([])
  expect(findWorkflowEntryActorRoles(workflow, 'approved', 'approved')).toEqual([])
})

test('enters a status without a transition under the least restricted transition into it', () => {
  // Every transition into `approved` is restricted, so a create into it needs one of their roles.
  expect(findWorkflowEntryActorRoles(workflow, undefined, 'approved')).toEqual(['project-manager', 'assignee'])
  expect(findWorkflowEntryActorRoles(workflow, undefined, 'review')).toEqual([])
  // A status no transition enters keeps the earlier behaviour.
  expect(findWorkflowEntryActorRoles(workflow, undefined, 'todo')).toEqual([])
})

test('lets only a person with an allowed role run a restricted transition', () => {
  expect(evaluateWorkflowTransitionActor([], member)).toBeUndefined()
  expect(evaluateWorkflowTransitionActor(['project-manager'], member)).toMatchObject({ rule: 'transition-actor' })
  expect(evaluateWorkflowTransitionActor(['project-manager'], { ...member, projectManager: true })).toBeUndefined()
  expect(evaluateWorkflowTransitionActor(['assignee'], { ...member, assignee: true })).toBeUndefined()
  expect(evaluateWorkflowTransitionActor(['project-manager'], {
    interactive: false,
    projectManager: true,
    assignee: true,
  })).toMatchObject({ rule: 'transition-actor', allowedActorRoles: ['project-manager'] })
})

test('lists every empty field a status requires', () => {
  const state = { hasDueDate: false, acceptanceCriteriaCount: 0, filledCustomFieldIds: new Set(['note']) }
  expect(evaluateWorkflowStatusRequirements({}, state)).toEqual([])
  expect(evaluateWorkflowStatusRequirements({
    requiredFields: ['due-date', 'acceptance-criteria'],
    requiredCustomFieldIds: ['note', 'risk'],
  }, state).map((condition) => condition.rule)).toEqual(['required-field', 'required-field', 'required-custom-field'])
  expect(evaluateWorkflowStatusRequirements({ requiredFields: ['due-date'] }, { ...state, hasDueDate: true })).toEqual([])
})
