import { describe, expect, test } from 'bun:test'
import {
  createWorkItemImportMemberMatcher,
  matchWorkItemImportPeople,
  namesImportMemberByDisplayName,
  toWorkItemImportMemberError,
} from './work-item-import-members'

const members = [
  { memberKey: 'hanako@example.com', name: 'Yamada Hanako' },
  { memberKey: 'taro@example.com', name: '佐藤 太郎' },
  { memberKey: 'taro2@example.com', name: '佐藤　太郎' },
  { memberKey: 'noname@example.com' },
]

describe('Work Item import member matching', () => {
  test('reads members only when a row names a person by display name', () => {
    expect(namesImportMemberByDisplayName({ assigneeUserId: 'a@example.com' })).toBe(false)
    expect(namesImportMemberByDisplayName({
      assigneeUserId: 'a@example.com',
      contributorAssignments: [{ jobRoleId: 'designer' }, { memberUserId: 'Hanako' }],
    })).toBe(true)
  })

  test('matches e-mail addresses in lower case and unique display names without case or width', () => {
    const match = createWorkItemImportMemberMatcher(members)

    expect(matchWorkItemImportPeople({
      assigneeUserId: ' Hanako@Example.com ',
      contributorAssignments: [{ memberUserId: 'yamada  hanako' }, { jobRoleId: 'designer' }],
      title: 'kept',
    }, match)).toEqual({
      people: {
        assigneeUserId: 'hanako@example.com',
        contributorAssignments: [{ memberUserId: 'hanako@example.com' }, { jobRoleId: 'designer' }],
        title: 'kept',
      },
    })
  })

  test('reports names that match no member or more than one', () => {
    const match = createWorkItemImportMemberMatcher(members)
    const result = matchWorkItemImportPeople({
      assigneeUserId: '佐藤 太郎',
      contributorAssignments: [{ memberUserId: 'Nobody' }],
    }, match)

    expect(result).toEqual({
      mismatches: [
        { field: 'assigneeUserId', value: '佐藤 太郎', ambiguous: true },
        { field: 'contributors', value: 'Nobody', ambiguous: false },
      ],
    })
    if (!('mismatches' in result)) throw new Error('expected mismatches')
    expect(result.mismatches.map((mismatch) => toWorkItemImportMemberError(4, mismatch).code))
      .toEqual(['ImportMemberAmbiguous', 'ImportMemberUnknown'])
  })

  test('treats every display name as unknown when members were not read', () => {
    expect(createWorkItemImportMemberMatcher()('Yamada Hanako')).toEqual({ ambiguous: false })
  })
})
