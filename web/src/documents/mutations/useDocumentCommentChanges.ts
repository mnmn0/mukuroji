import { useState } from 'react'
import { useSWRConfig } from 'swr'
import type { DocumentComment, DocumentMention } from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { deleteDocumentComment, updateDocumentComment } from '../api/comments'
import { replaceLoadedDocumentComment } from '../model/comments'

/**
 * Edits and deletes the viewer's own Document comments. After each change it puts the server's
 * copy into every cached thread of the Document, including a thread opened by a deep link, and
 * reloads the first comment page and those threads.
 *
 * @param accessToken - Documents API token.
 * @returns Actions that return the changed comment, so the caller can update comments it keeps
 *   outside the cache, such as older pages.
 */
export function useDocumentCommentChanges(accessToken: string | undefined) {
  const { mutate } = useSWRConfig()
  // One runner keeps the idempotency key of an unfinished change for its retry.
  const [runner] = useState(createMutationRequestRunner)

  /**
   * Applies the changed comment to the cached comment pages and threads of its Document.
   *
   * @param documentId - Document that owns the comment.
   * @param changed - Comment returned by the server.
   */
  const reconcile = async (documentId: string, changed: DocumentComment) => {
    await Promise.all([
      mutate(
        (key) => Array.isArray(key) && key[0] === 'document-comments' && key[2] === documentId,
      ),
      mutate(
        (key) => Array.isArray(key) && key[0] === 'document-comment-thread' && key[2] === documentId,
        (current: DocumentComment[] | undefined) => replaceLoadedDocumentComment(current, changed),
      ),
    ])
  }

  /**
   * Edits the body and mentions of one comment.
   *
   * @param documentId - Document that owns the comment.
   * @param commentId - Comment to edit.
   * @param input - New body and mentions.
   * @returns The edited comment, or undefined without an access token.
   */
  const editComment = async (
    documentId: string,
    commentId: string,
    input: { body: string; mentions: DocumentMention[] },
  ) => {
    if (!accessToken) return undefined
    const edited = await runner.run(
      `document:comment:edit:${documentId}:${commentId}`,
      JSON.stringify(input),
      (context) => updateDocumentComment(accessToken, documentId, commentId, input, context),
    )
    await reconcile(documentId, edited)
    return edited
  }

  /**
   * Deletes one comment, leaving a placeholder in its thread.
   *
   * @param documentId - Document that owns the comment.
   * @param commentId - Comment to delete.
   * @returns The deleted placeholder, or undefined without an access token.
   */
  const deleteComment = async (documentId: string, commentId: string) => {
    if (!accessToken) return undefined
    const deleted = await runner.run(
      `document:comment:delete:${documentId}:${commentId}`,
      commentId,
      (context) => deleteDocumentComment(accessToken, documentId, commentId, context),
    )
    await reconcile(documentId, deleted)
    return deleted
  }

  return { editComment, deleteComment }
}
