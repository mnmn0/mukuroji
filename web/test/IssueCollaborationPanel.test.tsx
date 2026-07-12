import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueCollaborationPanel } from '../src/issues/IssueCollaborationPanel'
import { mergeIssueComments } from '../src/issues/useIssueCollaboration'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
} from '../src/issues/fixtures'

describe('IssueCollaborationPanel', () => {
  test('does not let a later legacy page replace a persisted comment with the same ID', () => {
    const persisted = issueCollaborationControllerFixture.comments[0]
    const merged = mergeIssueComments([
      persisted,
      {
        ...persisted,
        bodyMarkdown: 'Legacy fallback',
        source: 'legacy',
        capabilities: {
          canDelete: false,
          canEdit: false,
          canReact: false,
          canReply: false,
          canResolve: false,
        },
      },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(persisted)
  })

  test('keeps legacy comments readable without unsupported reply and reaction actions', () => {
    const legacyComment = {
      ...issueCollaborationControllerFixture.comments[0],
      capabilities: {
        canDelete: false,
        canEdit: false,
        canReact: false,
        canReply: false,
        canResolve: false,
      },
      reactions: [],
      source: 'legacy' as const,
    }
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          comments: [legacyComment],
          hasMore: false,
          replyPagination: {
            [legacyComment.id]: { hasMore: true, isLoading: false },
          },
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Load earlier replies')
    expect(html).toContain('Watching project')
    expect(html).not.toContain('>Reply<')
    expect(html).not.toContain('aria-label="Add reaction"')
  })

  test('orders roots by newest timestamp across collaboration and legacy pages', () => {
    const rootComment = issueCollaborationControllerFixture.comments[0]
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          comments: [
            { ...rootComment, bodyMarkdown: 'Older root', createdAt: '2026-06-07T01:00:00.000Z' },
            {
              ...rootComment,
              bodyMarkdown: 'Newest root',
              createdAt: '2026-06-09T01:00:00.000Z',
              id: 'comment-newest',
              rootCommentId: 'comment-newest',
            },
          ],
          hasMore: false,
          replyPagination: {},
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html.indexOf('Newest root')).toBeLessThan(html.indexOf('Older root'))
  })
})
