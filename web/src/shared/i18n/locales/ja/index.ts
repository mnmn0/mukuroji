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
import { triageMessages } from './triage'
import { aiAssistanceMessages } from './ai-assistance'
import { customersMessages } from './customers'

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
  ...capacityPlanningMessages,
  ...triageMessages,
  ...aiAssistanceMessages,
  ...customersMessages,
} as const

/**
 * Translation key defined by the canonical Japanese dictionary.
 */
export type MessageKey = keyof typeof jaMessages
