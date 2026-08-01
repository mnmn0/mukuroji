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

/**
 * Complete Japanese message dictionary assembled from domain modules.
 */
export const jaMessages = {
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
} as const

/**
 * Translation key defined by the canonical Japanese dictionary.
 */
export type MessageKey = keyof typeof jaMessages
