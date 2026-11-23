import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveDocumentMentions } from '../src/documents/model/comments'
import { resolvePlanningUpdateCommentMentions } from '../src/planning/model/statusUpdateView'
import {
  filterMentionSuggestions,
  findMemberMentionRanges,
  formatMemberMentionLabel,
  readMentionAtCursor,
  resolveMentionedMemberKeys,
  type MentionableMember,
} from '../src/shared/lib/memberMentions'
import { MemberMentionTextarea } from '../src/shared/ui/MemberMentionTextarea'

const members: MentionableMember[] = [
  { memberKey: 'taro@example.com', email: 'taro@example.com', name: '山田 太郎', status: 'active' },
  { memberKey: 'ann@example.com', email: 'ann@example.com', name: 'Ann', status: 'active' },
  { memberKey: 'anna@example.com', email: 'anna@example.com', name: 'Anna', status: 'active' },
  { memberKey: 'kai-1@example.com', email: 'kai-1@example.com', name: 'Kai', status: 'active' },
  { memberKey: 'kai-2@example.com', email: 'kai-2@example.com', name: 'Kai', status: 'active' },
  { memberKey: 'gone@example.com', email: 'gone@example.com', name: 'Gone', status: 'deactivated' },
]

describe('display-name mentions', () => {
  test('finds picked names with spaces and keeps @Ann from matching @Anna', () => {
    const body = '@山田 太郎 と @Anna に確認'
    expect(findMemberMentionRanges(body, ['taro@example.com', 'ann@example.com', 'anna@example.com'], members))
      .toEqual([
        { memberKey: 'taro@example.com', offset: 0, length: 6 },
        { memberKey: 'anna@example.com', offset: 9, length: 5 },
      ])
  })

  test('tells duplicate names apart and ignores inactive or unpicked members', () => {
    const kai = members[3]!
    expect(formatMemberMentionLabel(kai, members)).toBe('Kai (kai-1@example.com)')
    const body = '@Kai (kai-1@example.com) @Gone @Ann'
    expect(resolveMentionedMemberKeys(body, ['kai-1@example.com', 'gone@example.com'], members))
      .toEqual(['kai-1@example.com'])
  })

  test('keeps the longest of overlapping name tokens', () => {
    const named: MentionableMember[] = [
      { memberKey: 'ann@example.com', name: 'Ann', status: 'active' },
      { memberKey: 'ann-smith@example.com', name: 'Ann Smith', status: 'active' },
    ]
    expect(findMemberMentionRanges('@Ann @Ann Smith', ['ann@example.com', 'ann-smith@example.com'], named))
      .toEqual([
        { memberKey: 'ann@example.com', offset: 0, length: 4 },
        { memberKey: 'ann-smith@example.com', offset: 5, length: 10 },
      ])
    expect(resolveDocumentMentions('@Ann Smith', ['ann@example.com', 'ann-smith@example.com'], named))
      .toEqual([{ userId: 'ann-smith@example.com', offset: 0, length: 10 }])
  })

  test('drops a picked member whose token was edited away', () => {
    expect(resolveMentionedMemberKeys('@An', ['ann@example.com'], members)).toEqual([])
  })

  test('reads the query before the cursor and filters active members', () => {
    expect(readMentionAtCursor('hi @山田', 6)).toEqual({ query: '山田', start: 3 })
    expect(readMentionAtCursor('mail@example', 12)).toBeUndefined()
    // The space after a finished token such as `@Ann ` closes the suggestions.
    expect(readMentionAtCursor('@Ann ', 5)).toBeUndefined()
    expect(readMentionAtCursor('@山田 太', 5)).toEqual({ query: '山田 太', start: 0 })
    expect(filterMentionSuggestions(members, 'ann').map((member) => member.memberKey))
      .toEqual(['ann@example.com', 'anna@example.com'])
    expect(filterMentionSuggestions(members, 'gone')).toEqual([])
  })
})

describe('Planning update comment mentions', () => {
  test('combines picked names with typed email mentions without double counting', () => {
    expect(resolvePlanningUpdateCommentMentions(
      '@Kai (kai-1@example.com) と @山田 太郎 @bob@example.com も',
      ['kai-1@example.com', 'taro@example.com'],
      members,
    )).toEqual(['bob@example.com', 'kai-1@example.com', 'taro@example.com'])
  })
})

describe('Document comment mentions', () => {
  test('keeps the first word of a picked name from becoming a member key', () => {
    expect(resolveDocumentMentions(
      '@山田 太郎 さんと @user-2 へ',
      ['taro@example.com'],
      members,
    )).toEqual([
      { userId: 'taro@example.com', offset: 0, length: 6 },
      { userId: 'user-2', offset: 11, length: 7 },
    ])
  })
})

describe('MemberMentionTextarea', () => {
  test('renders a combobox only when there are members to suggest', () => {
    const draft = { body: '', mentionMemberKeys: [] }
    const props = {
      ariaLabel: 'Comment',
      draft,
      onDraftChange: () => undefined,
      suggestionsLabel: 'Mention suggestions',
    }
    const withMembers = renderToStaticMarkup(<MemberMentionTextarea {...props} members={members} />)
    expect(withMembers).toContain('role="combobox"')
    expect(withMembers).toContain('aria-autocomplete="list"')
    expect(withMembers).not.toContain('role="listbox"')
    const plain = renderToStaticMarkup(<MemberMentionTextarea {...props} members={[]} />)
    expect(plain).not.toContain('role="combobox"')
  })

  test('says when the candidates failed to load and offers a retry', () => {
    const markup = renderToStaticMarkup(
      <MemberMentionTextarea
        ariaLabel="Comment"
        draft={{ body: '', mentionMemberKeys: [] }}
        members={[]}
        suggestionsFailure={{ message: 'Could not load names', retryLabel: 'Reload', onRetry: () => undefined }}
        suggestionsLabel="Mention suggestions"
        onDraftChange={() => undefined}
      />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Could not load names')
    expect(markup).toContain('>Reload</button>')
  })
})
