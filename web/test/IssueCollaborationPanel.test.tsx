import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssueCollaborationPanel } from '../src/issues/ui/IssueCollaborationPanel'
import { IssueActivityTab } from '../src/issues/ui/IssueActivityTab'
import type { TeamIssueComment } from '../src/issues/api'
import {
  acceptedResolutionHistoryFixtures,
  collaborationWorkspaceMemberFixtures,
  curatedContextRevisionFixtures,
  issueCollaborationControllerFixture,
} from '../src/issues/fixtures'
import { fileArtifactsControllerFixture, imageFileFixture } from '../src/files/fixtures'

describe('IssueCollaborationPanel', () => {
  test('localizes curated context activity event families', () => {
    const html = renderToStaticMarkup(
      <IssueActivityTab
        controller={{
          ...issueCollaborationControllerFixture,
          activity: [
            {
              eventId: 'event-context-created',
              eventType: 'context-item.created',
              occurredAt: '2026-06-08T01:00:00.000Z',
              actorUserId: 'demo@example.com',
            },
            {
              eventId: 'event-resolution-selected',
              eventType: 'accepted-resolution.selected',
              occurredAt: '2026-06-08T01:05:00.000Z',
              actorUserId: 'demo@example.com',
            },
          ],
        }}
        locale="ja"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Demo User が整理済みの判断を作成しました。')
    expect(html).toContain('Demo User が解決策を採用しました。')
  })

  test('orders roots by newest timestamp across collaboration pages', () => {
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

  test('keeps legacy comments read-only for attachments and context promotion', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        artifacts={fileArtifactsControllerFixture}
        controller={{
          ...issueCollaborationControllerFixture,
          comments: issueCollaborationControllerFixture.comments.map((comment) => {
            const legacyComment: TeamIssueComment = { ...comment, source: 'legacy' }
            return legacyComment
          }),
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).not.toContain('Attach file')
    expect(html).not.toContain('data-testid="comment-file-input-comment-1"')
    expect(html).not.toContain('>Reply</button>')
    expect(html).not.toContain('>Promote</button>')
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
        defaultTab="activity"
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

  test('keeps accepted resolution summary visible above a collapsed resolved thread', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={issueCollaborationControllerFixture}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Accepted resolution')
    expect(html).toContain('空状態の表示条件を含めてモバイルとデスクトップで確認する。')
    expect(html).toContain(
      'data-testid="comment-thread-details-comment-1"',
    )
    expect(html).toContain('2 comments')
  })

  test('hides accepted-resolution controls when the root thread is deleted', () => {
    const rootComment = issueCollaborationControllerFixture.comments[0]
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          comments: [
            { ...rootComment, deletedAt: '2026-06-08T01:45:00.000Z' },
            issueCollaborationControllerFixture.comments[1],
          ],
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).not.toContain('>Accept as resolution<')
    expect(html).not.toContain('>Replace resolution<')
    expect(html).not.toContain('Edit summary')
  })

  test('renders accepted resolution history only from its independent cursor state', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          context: {
            ...issueCollaborationControllerFixture.context,
            acceptedResolutionHistory: {
              hasLoadError: false,
              hasMore: true,
              isLoading: false,
              isLoadingMore: false,
              items: acceptedResolutionHistoryFixtures,
              rootCommentId: 'comment-1',
            },
          },
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Resolution history')
    expect(html).toContain('旧案では説明文だけを更新する。')
    expect(html).toContain('Superseded')
    expect(html).toContain('Captured source reply · revision 1')
    expect(html).toContain('Load earlier resolutions')
  })

  test('keeps revision loading, error, and empty states mutually exclusive', () => {
    const controller = {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        revisionHistory: {
          contextItemId: 'context-action-1',
          hasLoadError: false,
          hasMore: false,
          isLoading: true,
          isLoadingMore: false,
          items: [],
        },
      },
    }
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={controller}
        currentMemberKey="demo@example.com"
        defaultTab="decisions"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Loading change history…')
    expect(html).not.toContain('No earlier revisions are available.')
    expect(html).not.toContain('Failed to load change history.')
  })

  test('renders permission-filtered evidence in immutable context revisions', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={{
          ...issueCollaborationControllerFixture,
          context: {
            ...issueCollaborationControllerFixture.context,
            revisionHistory: {
              contextItemId: 'context-action-1',
              hasLoadError: false,
              hasMore: true,
              isLoading: false,
              isLoadingMore: false,
              items: curatedContextRevisionFixtures,
            },
          },
        }}
        currentMemberKey="demo@example.com"
        defaultTab="decisions"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('顧客ヒアリングを確認する')
    expect(html).toContain('Access revoked')
    expect(html).toContain(
      'You no longer have permission to view this external message.',
    )
    expect(html).toContain(
      'Quoted text, captured original, and permalink are hidden',
    )
    expect(html).toContain('Load earlier changes')
  })

  test('hides accepted-resolution mutations from a read-only root author', () => {
    const controller = {
      ...issueCollaborationControllerFixture,
      capabilities: {
        ...issueCollaborationControllerFixture.capabilities,
        canComment: false,
      },
      comments: issueCollaborationControllerFixture.comments.map((comment) =>
        comment.parentCommentId
          ? comment
          : {
          ...comment,
          acceptedResolutions: [],
          resolvedAt: undefined,
          resolvedByMemberKey: undefined,
          capabilities: {
            ...comment.capabilities,
            canResolve: false,
          },
        },
      ),
      context: {
        ...issueCollaborationControllerFixture.context,
        capabilities: {
          ...issueCollaborationControllerFixture.context.capabilities,
          canAcceptResolution: false,
        },
      },
    }
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={controller}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).not.toContain('Accept as resolution')
  })

  test('hides comment and activity promotion when curated context creation is read-only', () => {
    const controller = {
      ...issueCollaborationControllerFixture,
      context: {
        ...issueCollaborationControllerFixture.context,
        capabilities: {
          ...issueCollaborationControllerFixture.context.capabilities,
          canCreate: false,
        },
      },
    }
    const conversationHtml = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={controller}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )
    const activityHtml = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={controller}
        currentMemberKey="demo@example.com"
        defaultTab="activity"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(conversationHtml).not.toContain('>Promote</button>')
    expect(activityHtml).not.toContain('>Promote</button>')
    expect(activityHtml).not.toContain('aria-label="Promote activity:')
  })

  test('disables an open context editor after its create capability expires', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        contextDraft={{
          body: 'Keep the captured rationale.',
          kind: 'decision',
          title: 'Retain the decision',
        }}
        controller={{
          ...issueCollaborationControllerFixture,
          context: {
            ...issueCollaborationControllerFixture.context,
            capabilities: {
              ...issueCollaborationControllerFixture.context.capabilities,
              canCreate: false,
            },
          },
        }}
        currentMemberKey="demo@example.com"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain(
      'You no longer have permission to save this context change.',
    )
    expect(html).toMatch(
      /data-testid="context-editor-submit"[^>]*disabled=""/,
    )
  })

  test('never renders sensitive quote or permalink after source permission loss', () => {
    const html = renderToStaticMarkup(
      <IssueCollaborationPanel
        controller={issueCollaborationControllerFixture}
        currentMemberKey="demo@example.com"
        defaultTab="sources"
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
      />,
    )

    expect(html).toContain('Access revoked')
    expect(html).toContain('Research participant')
    expect(html).toContain('you no longer have source permission')
    expect(html).not.toContain('最初に何をすればよいか分かりませんでした。')
    expect(html).not.toContain('https://example.com/messages/42')
  })
})
