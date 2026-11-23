import useSWR from 'swr'
import type { AutomationTemplate } from '@mukuroji/contracts'
import { getAutomationTemplates } from '../api'

/** First element of the Work Item create panels' template cache key. */
export const WORK_ITEM_CREATE_TEMPLATES_KEY = 'work-item-create-templates'

/** Templates offered by a Work Item create panel, with their load state. */
export type WorkItemCreateTemplates = {
  /** Workspace templates of every kind; empty until they load or when they fail to load. */
  templates: readonly AutomationTemplate[]
  /** Whether the templates could not be loaded. */
  hasLoadError: boolean
}

/** Shared empty list, so an unloaded result keeps a stable identity. */
const noTemplates: readonly AutomationTemplate[] = []

/**
 * Reads the Workspace templates a Work Item create panel offers, while the panel is open.
 *
 * Members read templates with their Workspace read permission; a failure only hides the picker.
 *
 * @param accessToken - Bearer token, or undefined before sign-in.
 * @param enabled - Whether a create panel is open.
 * @returns The templates and whether they failed to load.
 */
export function useWorkItemCreateTemplates(
  accessToken: string | undefined,
  enabled: boolean,
): WorkItemCreateTemplates {
  const { data, error } = useSWR(
    enabled && accessToken ? [WORK_ITEM_CREATE_TEMPLATES_KEY, accessToken] as const : null,
    ([, token]) => getAutomationTemplates(token),
    { shouldRetryOnError: false },
  )
  return { templates: data ?? noTemplates, hasLoadError: error !== undefined }
}
