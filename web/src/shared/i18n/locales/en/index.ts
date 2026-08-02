import type { MessageKey } from '../ja'
import { coreMessages } from './core'
import { marketingMessages } from './marketing'
import { authMessages } from './auth'
import { workspaceMessages } from './workspace'
import { workItemsMessages } from './work-items'
import { issuesMessages } from './issues'
import { documentsMessages } from './documents'
import { searchMessages } from './search'
import { collaborationMessages } from './collaboration'
import { automationMessages } from './automation'
import { analyticsMessages } from './analytics'
import { planningMessages } from './planning'
import { requestsMessages } from './requests'
import { publicMessages } from './public'
import { securityMessages } from './security'
import { projectsMessages } from './projects'
import { capacityPlanningMessages } from './capacity-planning'

/**
 * Verifies that a locale dictionary contains exactly the canonical message keys.
 *
 * @param messages - Locale messages to validate at compile time.
 * @returns The validated locale messages without widening their keys.
 */
function defineMessages<const Messages extends Record<MessageKey, string>>(
  messages: Messages & Record<Exclude<keyof Messages, MessageKey>, never>,
): Messages {
  return messages
}

/**
 * Complete English message dictionary assembled from domain modules.
 */
export const enMessages = defineMessages({
  ...coreMessages,
  ...marketingMessages,
  ...authMessages,
  ...workspaceMessages,
  ...workItemsMessages,
  ...issuesMessages,
  ...documentsMessages,
  ...searchMessages,
  ...collaborationMessages,
  ...automationMessages,
  ...analyticsMessages,
  ...planningMessages,
  ...requestsMessages,
  ...publicMessages,
  ...securityMessages,
  ...projectsMessages,
  ...capacityPlanningMessages,
})
