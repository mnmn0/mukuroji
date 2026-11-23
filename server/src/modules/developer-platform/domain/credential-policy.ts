import type { ApiScope } from '@mukuroji/contracts'

/** All scopes that may be granted to a Developer Platform credential. */
export const API_SCOPES = [
  'work-items:read',
  'work-items:write',
  'work-items:delete',
  'webhooks:read',
  'webhooks:write',
  'integrations:read',
  'integrations:write',
  'imports:read',
  'imports:write',
] as const satisfies readonly ApiScope[]
