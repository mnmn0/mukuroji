import { describe, expect, test } from 'bun:test'
import {
  readPublicWorkItemCreateBody,
  readPublicWorkItemUpdateBody,
} from './work-item-schedule'

const injectedTransactItems = [
  {
    Delete: {
      TableName: 'mukuroji-team-issues-local',
      Key: { directoryTeamId: 'other-workspace#other-team', issueId: 'victim' },
    },
  },
]

describe('readPublicWorkItemUpdateBody', () => {
  test('rejects caller-supplied Agent Run transaction items', () => {
    expect(() => readPublicWorkItemUpdateBody({
      expectedRevision: 1,
      title: 'Injected',
      agentRunTransactItems: injectedTransactItems,
    })).toThrow('Work Item body contains internal fields: agentRunTransactItems.')
  })

  test('copies public fields into a new object and drops every other key', () => {
    const input = JSON.parse(JSON.stringify({
      expectedRevision: 3,
      title: 'Renamed',
      priority: 'high',
      progressPercent: null,
      idempotentIssueId: 'caller-selected-id',
      newWorkItemProjectConditionCheck: injectedTransactItems[0],
      unknownAdapterInput: injectedTransactItems,
    }))
    const body = readPublicWorkItemUpdateBody(input)

    expect(body).toEqual({
      expectedRevision: 3,
      title: 'Renamed',
      priority: 'high',
      progressPercent: null,
    })
    expect(body).not.toBe(input)
  })

  test('drops a JSON __proto__ key instead of copying it', () => {
    const body = readPublicWorkItemUpdateBody(
      JSON.parse('{"expectedRevision":1,"__proto__":{"agentRunTransactItems":[]}}'),
    )

    expect(body).toEqual({ expectedRevision: 1 })
    expect('agentRunTransactItems' in body).toBe(false)
  })

  test('rejects non-object bodies', () => {
    for (const input of [null, 'text', [], 1]) {
      expect(() => readPublicWorkItemUpdateBody(input)).toThrow('Work Item body must be an object.')
    }
  })
})

describe('readPublicWorkItemCreateBody', () => {
  test('rejects caller-supplied Agent Run transaction items', () => {
    expect(() => readPublicWorkItemCreateBody({
      title: 'Injected',
      schedule: null,
      agentRunTransactItems: injectedTransactItems,
    })).toThrow('Work Item body contains internal fields: agentRunTransactItems.')
  })

  test('copies public fields into a new object and drops every other key', () => {
    const input = {
      title: 'New',
      schedule: { mode: 'example' },
      quickCapture: true,
      expectedRevision: 9,
      planningRevisionFence: { expectedRevision: 0 },
      unknownAdapterInput: injectedTransactItems,
    }
    const body = readPublicWorkItemCreateBody(input)

    expect(body).toEqual({
      title: 'New',
      schedule: { mode: 'example' },
      quickCapture: true,
    })
    expect(body).not.toBe(input)
  })

  test('keeps a missing schedule undefined so the create path still rejects it', () => {
    expect(readPublicWorkItemCreateBody({ title: 'No schedule' })).toEqual({
      title: 'No schedule',
      schedule: undefined,
    })
  })
})
