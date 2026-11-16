import { ProjectDataError } from '../../modules/directory'
import type { WorkItemActualDateCorrection } from '../../modules/work-items'
import {
  canAccessAssignedProject,
  requireTeamPermission,
  type ProjectPrincipal,
} from './project-access'
import type { TeamPermissionContext } from './workspace-access'

/** Work Item update body split into the ordinary fields and the actual date correction. */
export type WorkItemActualDateCorrectionRequest<TBody> = {
  /** Update body without the actual date fields. */
  body: TBody
  /** Requested correction, or undefined when the body does not touch the actual dates. */
  correction?: WorkItemActualDateCorrection
}

/**
 * Separates the manager-only actual date fields from an untrusted Work Item update body.
 *
 * @param input - Untrusted update body already checked for internal fields.
 * @returns The remaining body and the type-checked correction.
 * @throws ProjectDataError when an actual date field is neither a string nor null.
 */
export function readWorkItemActualDateCorrection<
  TBody extends { actualStartDate?: unknown, actualEndDate?: unknown },
>(
  input: TBody,
): WorkItemActualDateCorrectionRequest<Omit<TBody, 'actualStartDate' | 'actualEndDate'>> {
  const { actualStartDate, actualEndDate, ...body } = input
  if (!('actualStartDate' in input) && !('actualEndDate' in input)) {
    return { body }
  }
  return {
    body,
    correction: {
      ...('actualStartDate' in input
        ? { actualStartDate: readCorrectionValue(actualStartDate, 'actualStartDate') }
        : {}),
      ...('actualEndDate' in input
        ? { actualEndDate: readCorrectionValue(actualEndDate, 'actualEndDate') }
        : {}),
    },
  }
}

/**
 * Reads one requested actual date correction value.
 *
 * @param value - Untrusted request value.
 * @param field - Field name used in the error message.
 * @returns The requested date, or null to remove the date.
 * @throws ProjectDataError when the value is neither a string nor null.
 */
function readCorrectionValue(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value
  throw new ProjectDataError(
    400,
    'InvalidWorkItemActualDates',
    `${field} must be a YYYY-MM-DD date or null.`,
  )
}

/**
 * Requires the principal to manage the Work Item's assigned Project or its Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the Work Item.
 * @param context - Team permission context already resolved for the update.
 * @param assignedProjectId - Project the Work Item is assigned to, if any.
 * @returns Nothing when the principal may correct the actual dates.
 * @throws ProjectDataError when the principal is not a manager.
 */
export async function requireWorkItemActualDateCorrectionPermission(
  principal: ProjectPrincipal,
  teamId: string,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
): Promise<void> {
  if (assignedProjectId && canAccessAssignedProject(principal, context, assignedProjectId, 'manager')) {
    return
  }
  await requireTeamPermission(principal, teamId, 'manager')
}
