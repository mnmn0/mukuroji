import { useRef, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { Locale } from '../../shared/i18n/i18n'
import { createDocument, type CreateDocumentInput } from '../api'
import {
  buildBuiltInDocumentTemplate,
  formatLocalCalendarDate,
  type BuiltInDocumentTemplateContent,
  type BuiltInDocumentTemplateKey,
  type BuiltInTemplateCreateOptions,
} from '../model/builtInTemplates'
import { createDocumentClientId } from '../model/document'

/**
 * Options for creating pages from the templates bundled with every Workspace.
 */
export type UseBuiltInTemplateDocumentCreationOptions = {
  /** Workspace API token; omission makes every create a no-op. */
  accessToken?: string
  /** Language of the template text. */
  locale: Locale
  /**
   * Refreshes the Document caches and opens the created page. Creation stays
   * pending until it settles, so a second click cannot create a duplicate.
   */
  onCreated: (documentId: string) => Promise<unknown> | void
}

/**
 * Generated page content kept until its create request succeeds.
 */
type RetainedTemplateContent = {
  /** Template choice and substituted values the content was built from. */
  fingerprint: string
  /** Title and blocks sent with the create request. */
  content: BuiltInDocumentTemplateContent
}

/**
 * Creates pages from the templates bundled with every Workspace.
 *
 * A retry after a lost response resends the same generated blocks, because
 * the server fingerprints the create body and block IDs are random.
 *
 * @param options - API token, template language, and the cache refresh.
 * @returns The create action and whether a create is pending.
 */
export function useBuiltInTemplateDocumentCreation({
  accessToken,
  locale,
  onCreated,
}: UseBuiltInTemplateDocumentCreationOptions) {
  const [mutationRunner] = useState(createMutationRequestRunner)
  const retainedRef = useRef<RetainedTemplateContent | undefined>(undefined)
  const pendingRef = useRef(false)
  const [isCreating, setIsCreating] = useState(false)

  /**
   * Creates a page with today's date, the chosen Project, and the
   * participants substituted into a bundled template.
   *
   * @param key - Bundled template to use.
   * @param options - Project and participants chosen on the home.
   */
  const createFromTemplate = async (
    key: BuiltInDocumentTemplateKey,
    options: BuiltInTemplateCreateOptions,
  ): Promise<void> => {
    if (!accessToken || pendingRef.current) return
    pendingRef.current = true
    setIsCreating(true)
    try {
      await createAndOpen(accessToken, key, options)
    } finally {
      pendingRef.current = false
      setIsCreating(false)
    }
  }

  /**
   * Sends the create request with retained content and opens the new page.
   *
   * @param token - Workspace API token.
   * @param key - Bundled template to use.
   * @param options - Project and participants chosen on the home.
   */
  const createAndOpen = async (
    token: string,
    key: BuiltInDocumentTemplateKey,
    options: BuiltInTemplateCreateOptions,
  ) => {
    const date = formatLocalCalendarDate(new Date())
    const fingerprint = JSON.stringify([
      key,
      locale,
      date,
      options.projectId ?? '',
      options.projectName ?? '',
      options.participants,
    ])
    const retained = retainedRef.current
    const content =
      retained?.fingerprint === fingerprint
        ? retained.content
        : buildBuiltInDocumentTemplate(
            key,
            locale,
            {
              date,
              participants: options.participants,
              projectName: options.projectName,
            },
            createDocumentClientId,
          )
    retainedRef.current = { content, fingerprint }
    const input: CreateDocumentInput = {
      blocks: content.blocks,
      kind: 'page',
      scope: options.projectId
        ? { projectId: options.projectId, type: 'project' }
        : { type: 'workspace' },
      title: content.title,
    }
    const created = await mutationRunner.run(
      `document:create:built-in:${key}`,
      fingerprint,
      (context) => createDocument(token, input, context),
    )
    retainedRef.current = undefined
    await onCreated(created.id)
  }

  return { createFromTemplate, isCreating }
}
