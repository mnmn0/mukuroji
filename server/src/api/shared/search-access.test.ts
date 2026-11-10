import { expect, test } from 'bun:test'
import { parseSearchWorkItemEntityIdForTeam } from './search-access'

test('splits an indexed Work Item ID by the Team recorded on the search document', () => {
  expect(parseSearchWorkItemEntityIdForTeam('team/core/issue/a/b', 'core')).toEqual({ teamId: 'core', issueId: 'a/b' })
  // Without a recorded Team, the plain grammar still applies.
  expect(parseSearchWorkItemEntityIdForTeam('team/core/issue/a', undefined)).toEqual({ teamId: 'core', issueId: 'a' })
  expect(parseSearchWorkItemEntityIdForTeam('team/core/issue/a/b', undefined)).toBeUndefined()
})

test('rejects a search document whose ID names another Team', () => {
  expect(parseSearchWorkItemEntityIdForTeam('team/other/issue/a', 'core')).toBeUndefined()
  expect(parseSearchWorkItemEntityIdForTeam('team/core/issue/', 'core')).toBeUndefined()
  expect(parseSearchWorkItemEntityIdForTeam('team/a/b/issue/c', 'a/b')).toBeUndefined()
})
