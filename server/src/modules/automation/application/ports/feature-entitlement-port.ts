/** Server-side feature gate required by trusted Automation workers. */
export interface AutomationFeatureEntitlementPort {
  /** Returns whether Automation execution is currently enabled for a Workspace. */
  isAutomationEnabled(workspaceId: string): Promise<boolean>
}
