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
  /** Refreshes every cache that lists Documents after a page is created. */
  onCreated: () => Promise<unknown>
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
 * @returns The create action, which resolves to the new page ID.
 */
export function useBuiltInTemplateDocumentCreation({
  accessToken,
  locale,
  onCreated,
}: UseBuiltInTemplateDocumentCreationOptions) {
  const [mutationRunner] = useState(createMutationRequestRunner)
  const retainedRef = useRef<RetainedTemplateContent | undefined>(undefined)

  /**
   * Creates a page with today's date, the chosen Project, and the
   * participants substituted into a bundled template.
   *
   * @param key - Bundled template to use.
   * @param options - Project and participants chosen on the home.
   * @returns ID of the created page, or undefined without a token.
   */
  const createFromTemplate = async (
    key: BuiltInDocumentTemplateKey,
    options: BuiltInTemplateCreateOptions,
  ): Promise<string | undefined> => {
    if (!accessToken) return undefined
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
      (context) => createDocument(accessToken, input, context),
    )
    retainedRef.current = undefined
    await onCreated()
    return created.id
  }

  return { createFromTemplate }
}
