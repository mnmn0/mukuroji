import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueCollaborationPanel } from '../src/issues/IssueCollaborationPanel'
import { mergeIssueComments } from '../src/issues/useIssueCollaboration'
import {
  collaborationWorkspaceMemberFixtures,
  issueCollaborationControllerFixture,
} from '../src/issues/fixtures'
import { fileArtifactsControllerFixture, imageFileFixture } from '../src/files/fixtures'

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

  test('shows files attached to a saved comment and keeps the attach action resource scoped', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        artifacts={{
          ...fileArtifactsControllerFixture,
          files: [{ ...imageFileFixture, targetId: 'comment-1', targetType: 'comment' }],
        }}
        controller={issueCollaborationControllerFixture}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('launch-hero.png')
    expect(html).toContain('Attach file')
    expect(html).toContain('Allow guest access')
    expect(html).toContain('data-testid="comment-file-input-comment-1"')
  })

  test('hides the comment guest-sharing option without manager capability', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        artifacts={{
          ...fileArtifactsControllerFixture,
          capabilities: { canRequestApproval: true, canUpload: true },
          files: [{ ...imageFileFixture, targetId: 'comment-1', targetType: 'comment' }],
        }}
        controller={issueCollaborationControllerFixture}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Attach file')
    expect(html).not.toContain('Allow guest access')
  })

  test('maps the exact server file and approval event names', () => {
    const eventTypes = [
      'file.created',
      'file.version-created',
      'file.upload-completed',
      'file.download-accessed',
      'file.preview-accessed',
      'file.deleted',
      'annotation.created',
      'approval.requested',
      'approval.approved',
      'approval.completed',
      'approval.rejected',
      'approval.changes-requested',
      'approval.cancelled',
    ]
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          activity: eventTypes.map((eventType, index) => ({
            actorUserId: 'demo@example.com',
            eventId: `event-${index}`,
            eventType,
            occurredAt: `2026-07-12T03:${String(index).padStart(2, '0')}:00.000Z`,
          })),
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    for (const message of [
      'Demo User started adding a file.',
      'Demo User added a new file version.',
      'Demo User completed a file upload.',
      'Demo User downloaded a file.',
      'Demo User previewed a file.',
      'Demo User deleted a file.',
      'Demo User added a positional annotation.',
      'Demo User requested approval.',
      'Demo User approved the version.',
      'Demo User completed the approval.',
      'Demo User rejected the version.',
      'Demo User requested changes.',
      'Demo User cancelled the approval request.',
    ]) {
      expect(html).toContain(message)
    }
  })
})
