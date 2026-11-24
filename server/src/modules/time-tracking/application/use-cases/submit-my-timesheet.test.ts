import { expect, test } from 'bun:test'
import { submitMyTimesheet } from './submit-my-timesheet'

test('submits each permitted Team once and reports the others as failed', async () => {
  const calls: string[] = []
  const result = await submitMyTimesheet({
    async submitTeamEntries(teamId, entries) {
      calls.push(`${teamId}:${entries.map((entry) => entry.entryId).join(',')}`)
      if (teamId === 'team-broken') throw new Error('lost access')
      return { count: entries.length - 1, failedEntryIds: entries.slice(1).map((entry) => entry.entryId) }
    },
  }, {
    entries: [
      { teamId: 'team-1', entryId: 'a', expectedRevision: 1 },
      { teamId: 'team-hidden', entryId: 'b', expectedRevision: 1 },
      { teamId: 'team-1', entryId: 'c', expectedRevision: 2 },
      { teamId: 'team-broken', entryId: 'd', expectedRevision: 1 },
    ],
    permittedTeamIds: new Set(['team-1', 'team-broken']),
  })

  expect(calls).toEqual(['team-1:a,c', 'team-broken:d'])
  expect(result).toEqual({
    count: 1,
    failedEntryIds: ['c', 'b', 'd'],
    partialFailure: true,
    teams: [
      { teamId: 'team-1', count: 1, failedEntryIds: ['c'] },
      { teamId: 'team-hidden', count: 0, failedEntryIds: ['b'], failed: true },
      { teamId: 'team-broken', count: 0, failedEntryIds: ['d'], failed: true },
    ],
  })
})
