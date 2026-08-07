import { expect, test } from 'bun:test'
import {
  EXTERNAL_CHAT_SCHEMA_VERSION,
  type ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import { composeExternalChatLinkProjectionWithLifecycleFloor } from './external-chat-lifecycle'

/** Creates a deleted link whose source projection still contains provider metadata. */
function createDeletedLinkWithMetadata(): ExternalChatWorkItemLink {
  return {
    schemaVersion: EXTERNAL_CHAT_SCHEMA_VERSION,
    id: 'link-1',
    teamId: 'team-1',
    workItemId: 'work-item-1',
    installationId: 'installation-1',
    provider: 'slack',
    workspace: {
      provider: 'slack',
      externalId: 'workspace-1',
      displayName: 'Workspace',
      permalink: 'https://chat.example.test/workspace-1',
    },
    conversation: {
      externalId: 'conversation-1',
      externalWorkspaceId: 'workspace-1',
      kind: 'channel',
      displayName: 'Channel',
      permalink: 'https://chat.example.test/conversation-1',
    },
    source: {
      externalWorkspaceId: 'workspace-1',
      conversationExternalId: 'conversation-1',
      threadExternalId: 'thread-1',
      rootMessageExternalId: 'message-1',
      sourceMessageExternalId: 'message-2',
      sourcePermalink: 'https://chat.example.test/thread-1',
      quotedRange: {
        sourceMessageExternalId: 'message-2',
        startOffset: 0,
        endOffset: 7,
        text: 'quoted',
      },
    },
    syncDirection: 'bidirectional',
    syncStatus: 'synced',
    sourceAvailability: 'available',
    sourceState: 'deleted',
    revision: 1,
    createdAt: '2026-08-06T06:00:00.000Z',
    updatedAt: '2026-08-06T06:00:00.000Z',
  }
}

test('redacts metadata when the lifecycle floor equals a deleted candidate', () => {
  const result = composeExternalChatLinkProjectionWithLifecycleFloor(
    createDeletedLinkWithMetadata(),
    { availability: 'available', state: 'deleted' },
  )

  expect(result).toMatchObject({
    workspace: { provider: 'slack', externalId: 'workspace-1' },
    conversation: {
      externalId: 'conversation-1',
      externalWorkspaceId: 'workspace-1',
      kind: 'channel',
    },
    source: {
      externalWorkspaceId: 'workspace-1',
      conversationExternalId: 'conversation-1',
      threadExternalId: 'thread-1',
      rootMessageExternalId: 'message-1',
      sourceMessageExternalId: 'message-2',
    },
    sourceAvailability: 'available',
    sourceState: 'deleted',
    syncStatus: 'paused',
  })
  expect(result.workspace.displayName).toBeUndefined()
  expect(result.workspace.permalink).toBeUndefined()
  expect(result.conversation.displayName).toBeUndefined()
  expect(result.conversation.permalink).toBeUndefined()
  expect(result.source.sourcePermalink).toBeUndefined()
  expect(result.source.quotedRange).toBeUndefined()
})
