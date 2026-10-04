import publicApiOpenApiDocumentJson from '../openapi/public-api-v1.json' with { type: 'json' }

/**
 * Public REST API major version.
 */
export const PUBLIC_API_VERSION: 'v1' = 'v1'

/**
 * Public endpoint that returns the OpenAPI 3.1 document.
 */
export const PUBLIC_API_OPENAPI_PATH: '/api/v1/openapi.json' =
  '/api/v1/openapi.json'

/**
 * Canonical Public API and developer-management OpenAPI 3.1 document.
 */
export const PUBLIC_API_OPENAPI_DOCUMENT = publicApiOpenApiDocumentJson

/**
 * Camel-case alias retained for existing consumers.
 */
export const publicApiOpenApiDocument = PUBLIC_API_OPENAPI_DOCUMENT
