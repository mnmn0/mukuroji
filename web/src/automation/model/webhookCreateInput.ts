import type { CreateAutomationInboundWebhookEndpointInput } from '@mukuroji/contracts'

/**
 * Builds the inbound Webhook create input from the form state.
 * A Triage Team that is no longer offered falls back to an Automation endpoint, so a form
 * whose purpose selector disappeared cannot create a Triage endpoint.
 * @param name Trimmed endpoint name.
 * @param triageTeamId Team ID selected for Triage routing, or an empty string.
 * @param teams Teams currently offered for Triage routing.
 * @returns The create input to send.
 */
export function buildInboundWebhookCreateInput(
  name: string,
  triageTeamId: string,
  teams: readonly { id: string }[],
): CreateAutomationInboundWebhookEndpointInput {
  return triageTeamId && teams.some((team) => team.id === triageTeamId)
    ? { name, purpose: 'triage', triageRouting: { teamId: triageTeamId } }
    : { name }
}
