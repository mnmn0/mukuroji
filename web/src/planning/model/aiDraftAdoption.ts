/** Result of routing an approved AI Planning draft into a local form. */
export type AiPlanningDraftAdoptionResult =
  | 'applied'
  | 'confirmation-required'

/** Callbacks used to route an approved AI Planning draft safely. */
export type AiPlanningDraftAdoptionHandlers<Draft> = {
  /** Applies the draft immediately when no manual edits can be lost. */
  apply: (draft: Draft) => void
  /** Stages the draft behind an explicit replacement confirmation. */
  confirm: (draft: Draft) => void
}

/**
 * Routes an approved AI draft without silently replacing manual form edits.
 *
 * @param draft - Approved, revision-fenced Planning draft for one local form.
 * @param isFormDirty - Whether the operator has changed any manual form field.
 * @param handlers - Immediate-apply and confirmation-staging callbacks.
 * @returns Whether the draft was applied or staged for confirmation.
 */
export function routeAiPlanningDraftAdoption<Draft>(
  draft: Draft,
  isFormDirty: boolean,
  handlers: AiPlanningDraftAdoptionHandlers<Draft>,
): AiPlanningDraftAdoptionResult {
  if (isFormDirty) {
    handlers.confirm(draft)
    return 'confirmation-required'
  }
  handlers.apply(draft)
  return 'applied'
}
