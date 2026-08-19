import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from '@jest/globals'
import {
  requireTeamIssueCommentIndexDeploymentStage,
  resolveTeamIssueCommentIndexDeploymentStage,
  teamIssueCommentIndexDeploymentIncludes,
  type TeamIssueCommentIndexDeploymentStage,
} from '../lib/config/team-issue-comment-index-deployment'
import { buildDataStores } from '../lib/subsystems/data-stores'

/**
 * Narrows one synthesized CloudFormation value to a string-keyed record.
 *
 * @param value - Candidate synthesized value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Synthesizes the Team Issue event table at one reviewed rollout stage.
 *
 * @param stage - Stage whose Team Issue event indexes should be inspected.
 * @returns Global secondary index names synthesized for the event table.
 */
function synthesizeTeamIssueEventIndexNames(
  stage: TeamIssueCommentIndexDeploymentStage,
): string[] {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TeamIssueCommentIndex${stage}`)
  const connectorRuntimeConfiguration = new cdk.CfnParameter(
    stack,
    'ConnectorRuntimeConfiguration',
    { noEcho: true, type: 'String' },
  )
  const stores = buildDataStores(stack, {
    connectorRuntimeConfiguration,
    teamIssueCommentIndexDeploymentStage: stage,
    triageIndexDeploymentStage: 'wake',
  })
  const tableResource = stores.teamIssueEventsTable.node.defaultChild
  if (!(tableResource instanceof cdk.CfnResource)) {
    throw new Error('Team Issue event table resource was not synthesized.')
  }
  const tableLogicalId = stack.getLogicalId(tableResource)
  const document: unknown = Template.fromStack(stack).toJSON()
  if (!isRecord(document) || !isRecord(document.Resources)) {
    throw new Error('Data-store template was not synthesized.')
  }
  const table = document.Resources[tableLogicalId]
  if (!isRecord(table) || !isRecord(table.Properties)) {
    throw new Error('Team Issue event table definition was not synthesized.')
  }
  const indexes = table.Properties.GlobalSecondaryIndexes
  if (!Array.isArray(indexes)) return []
  return indexes.flatMap((index) =>
    isRecord(index) && typeof index.IndexName === 'string'
      ? [index.IndexName]
      : [],
  )
}

test('defaults to a single deploy-safe Team Issue event index addition', () => {
  const stage = resolveTeamIssueCommentIndexDeploymentStage(undefined)

  expect(stage).toBe('event')
  expect(teamIssueCommentIndexDeploymentIncludes(stage, 'event')).toBe(true)
  expect(teamIssueCommentIndexDeploymentIncludes(stage, 'comment')).toBe(false)
  expect(synthesizeTeamIssueEventIndexNames(stage)).toEqual([
    'TeamIssueEventCreatedAtIndex',
  ])
})

test('adds the comment-time GSI only at the second rollout stage', () => {
  const eventIndexes = synthesizeTeamIssueEventIndexNames('event')
  const commentIndexes = synthesizeTeamIssueEventIndexNames('comment')

  expect(commentIndexes.filter((index) => !eventIndexes.includes(index))).toEqual([
    'TeamIssueCommentCreatedAtIndex',
  ])
})

test('rejects unreviewed Team Issue event index rollout context values', () => {
  expect(() => requireTeamIssueCommentIndexDeploymentStage(undefined)).toThrow(
    'teamIssueCommentIndexDeploymentStage context is required to prevent an accidental Team Issue GSI rollback.',
  )
  expect(() => resolveTeamIssueCommentIndexDeploymentStage('all')).toThrow(
    'teamIssueCommentIndexDeploymentStage must be one of event or comment.',
  )
  expect(() => resolveTeamIssueCommentIndexDeploymentStage(3)).toThrow(
    'teamIssueCommentIndexDeploymentStage must be one of event or comment.',
  )
})
