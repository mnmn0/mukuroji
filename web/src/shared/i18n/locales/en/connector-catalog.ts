/** English copy for the connector catalog that lists only the providers configured in this environment. */
export const connectorCatalogMessages = {
  'connectors.catalog.emptyTitle': 'No connectors are available',
  'connectors.catalog.emptyDescription': 'Only providers configured in this environment are listed. Once an operator configures a provider, you can connect it here.',
  'connectors.catalog.availabilityLoading': 'Checking the connectors available in this environment',
  'connectors.catalog.availabilityError': 'The connectors available in this environment could not be checked. New connections stay hidden until they load.',
  'connectors.catalog.notConfigured': 'This provider is not configured in this environment, so new accounts cannot be connected.',
} as const
