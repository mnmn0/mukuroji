import type {
  CustomFieldDefinition,
  PublicCustomFieldDefinition,
  PublicWorkItemTypeChangePreview,
  WorkItemTypeChangePreview,
} from '@mukuroji/contracts'

/**
 * Redacts one custom field definition before it crosses the Public API boundary.
 *
 * @param definition - Validated field definition from the effective configuration.
 * @param typeRequired - Whether the selected Work Item Type requires this field.
 * @param accessibleProjectIds - Project IDs visible to the caller, or undefined for unrestricted access.
 * @returns A public definition, or undefined when its Project scope is not visible.
 */
export function createPublicCustomFieldDefinition(
  definition: CustomFieldDefinition,
  typeRequired: boolean,
  accessibleProjectIds: ReadonlySet<string> | undefined,
): PublicCustomFieldDefinition | undefined {
  const configuredProjectIds = definition.projectIds
  const visibleProjectIds = configuredProjectIds && configuredProjectIds.length > 0 && accessibleProjectIds
    ? configuredProjectIds.filter((projectId) => accessibleProjectIds.has(projectId))
    : configuredProjectIds
  if (
    configuredProjectIds &&
    configuredProjectIds.length > 0 &&
    accessibleProjectIds &&
    visibleProjectIds?.length === 0
  ) {
    return undefined
  }

  return {
    id: definition.id,
    name: definition.name,
    type: definition.type,
    sortOrder: definition.sortOrder,
    required: definition.required || typeRequired,
    ...(definition.defaultValue === undefined ? {} : { defaultValue: definition.defaultValue }),
    ...(definition.options === undefined ? {} : { options: definition.options }),
    ...(definition.validation === undefined ? {} : { validation: definition.validation }),
    ...(visibleProjectIds === undefined ? {} : { projectIds: visibleProjectIds }),
    ...(definition.currencyCode === undefined ? {} : { currencyCode: definition.currencyCode }),
    ...(definition.durationUnit === undefined ? {} : { durationUnit: definition.durationUnit }),
  }
}

/**
 * Projects an internal Work Item Type change preview to the public response shape.
 *
 * @param preview - Internal preview calculated from the authoritative configuration.
 * @param accessibleProjectIds - Project IDs visible to the caller, or undefined for unrestricted access.
 * @returns Preview with only public custom field definition properties.
 */
export function projectPublicWorkItemTypeChangePreview(
  preview: WorkItemTypeChangePreview,
  accessibleProjectIds: ReadonlySet<string> | undefined,
): PublicWorkItemTypeChangePreview {
  return {
    ...preview,
    missingRequiredCustomFieldDefinitions: preview.missingRequiredCustomFieldDefinitions.flatMap(
      (definition) => {
        const publicDefinition = createPublicCustomFieldDefinition(
          definition,
          true,
          accessibleProjectIds,
        )
        return publicDefinition ? [publicDefinition] : []
      },
    ),
  }
}
