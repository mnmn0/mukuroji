import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_API_OPENAPI_DOCUMENT } from '../contracts/src/openapi'

/**
 * Stable categories emitted by the Public API compatibility checker.
 */
export type PublicApiCompatibilityRule =
  | 'invalid-contract'
  | 'operation-contract'
  | 'parameter-contract'
  | 'reference-contract'
  | 'request-contract'
  | 'response-contract'
  | 'schema-contract'
  | 'security-contract'

/**
 * One backward-compatibility violation with a stable location and category.
 */
export interface PublicApiCompatibilityIssue {
  /** JSON-style location of the incompatible contract element. */
  readonly location: string
  /** Human-readable explanation of the rejected change. */
  readonly message: string
  /** Stable compatibility rule category used by tests and CI output. */
  readonly rule: PublicApiCompatibilityRule
}

/**
 * JSON object shape used after runtime narrowing.
 */
type JsonRecord = Readonly<Record<string, unknown>>

/**
 * Direction in which a schema is consumed across the HTTP boundary.
 */
type SchemaDirection = 'request' | 'response'

/**
 * Mutable collector used internally before the public immutable result is returned.
 */
type IssueCollector = PublicApiCompatibilityIssue[]

/**
 * Object pairs already traversed during one recursive comparison.
 */
type ComparedObjectPairs = WeakMap<JsonRecord, WeakSet<JsonRecord>>

/**
 * Schema object pairs already traversed during one directional comparison.
 */
type ComparedSchemaPairs = ComparedObjectPairs

/**
 * Header object pairs already traversed during one recursive comparison.
 */
type ComparedHeaderPairs = ComparedObjectPairs

/**
 * A resolved parameter together with its stable OpenAPI identity.
 */
interface ResolvedParameter {
  /** Parameter location such as path, query, or header. */
  readonly inputLocation: string
  /** Normalized `(in,name)` identity, with case-insensitive header names. */
  readonly key: string
  /** Parameter name preserved for diagnostic locations. */
  readonly name: string
  /** Resolved parameter object from the owning document. */
  readonly value: JsonRecord
}

/**
 * Parsed and normalized representation of one OpenAPI path template.
 */
interface ParsedPathTemplate {
  /** Parameter names in their path-template order. */
  readonly placeholders: readonly string[]
  /** Template with every parameter name replaced by the same sentinel. */
  readonly normalized: string
}

/**
 * Semantic role used while compacting a composition value.
 */
type SchemaExpansionContext =
  | 'literal'
  | 'schema'
  | 'schema-array'
  | 'schema-map'
  | 'semantic'
  | 'semantic-map'

/**
 * Shared traversal accounting for adversarial schema graphs.
 */
interface SchemaTraversalBudget {
  /** Whether a budget finding was already emitted for this traversal. */
  exceeded: boolean
  /** Number of array, object, and scalar nodes visited so far. */
  visitedNodes: number
}

/**
 * Memoization and active-stack state for schema reference validation.
 */
interface SchemaReferenceValidationState {
  /** References on the current depth-first path, used to reject cycles. */
  readonly activeReferences: Set<string>
  /** References whose complete target graph was already validated. */
  readonly completedReferences: Set<string>
  /** References whose target graph already produced a fail-closed finding. */
  readonly invalidReferences: Set<string>
  /** Maximum structural depth below each successfully validated reference. */
  readonly referenceDepths: Map<string, number>
  /** Resolved schema root objects already traversed in this document. */
  readonly validatedRoots: WeakSet<JsonRecord>
  /** Explicit depth and traversal-node accounting. */
  readonly budget: SchemaTraversalBudget
}

/**
 * Memoization and graph-definition state for semantic reference expansion.
 */
interface SchemaReferenceExpansionState {
  /** References on the current depth-first path, used to reject cycles. */
  readonly activeReferences: Set<string>
  /** Compact semantic value memoized for each completed local reference. */
  readonly expandedReferences: Map<string, unknown>
  /** Explicit depth and traversal-node accounting. */
  readonly budget: SchemaTraversalBudget
}

/**
 * Tagged normalization result that distinguishes omission from invalid security.
 */
interface NormalizedSecurityResult {
  /** Whether the supplied security requirement value was structurally valid. */
  readonly valid: boolean
  /** Canonical alternatives, or undefined only for an omitted valid value. */
  readonly value: readonly unknown[] | undefined
}

/**
 * Cached semantic fingerprint of one referenced Security Scheme Object.
 */
interface SecuritySchemeFingerprint {
  /** Fixed-size digest when the scheme resolved and normalized successfully. */
  readonly digest: string | undefined
  /** Whether the referenced scheme was valid and fingerprintable. */
  readonly valid: boolean
}

/**
 * Cached effective security contract for one document and requirement value.
 */
interface EffectiveSecurityContract {
  /** Digest of canonical security requirement alternatives. */
  readonly requirementsDigest: string
  /** Digest of every referenced scheme name and definition fingerprint. */
  readonly schemesDigest: string
  /** Whether requirements and every referenced scheme were valid. */
  readonly valid: boolean
}

/**
 * Run-wide traversal state shared by every schema root in one comparison.
 */
interface SchemaTraversalContext {
  /** Per-document budgets shared by all semantic expansion roots. */
  readonly expansionBudgets: WeakMap<JsonRecord, SchemaTraversalBudget>
  /** Effective contracts for omitted security, keyed by owning document. */
  readonly omittedSecurityContracts: WeakMap<JsonRecord, EffectiveSecurityContract>
  /** Effective contracts for concrete security arrays, keyed by document and identity. */
  readonly securityContracts: WeakMap<
    JsonRecord,
    WeakMap<object, EffectiveSecurityContract>
  >
  /** Per-document semantic fingerprints of referenced security schemes. */
  readonly securitySchemeFingerprints: WeakMap<
    JsonRecord,
    Map<string, SecuritySchemeFingerprint>
  >
  /** Per-document reference validation memoization and budgets. */
  readonly validationStates: WeakMap<JsonRecord, SchemaReferenceValidationState>
}

const HTTP_METHODS = [
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]
const ANNOTATION_KEYS = new Set([
  'description',
  'example',
  'examples',
  'externalDocs',
  'summary',
  'title',
])
const SEMANTIC_NAME_MAP_KEYS = new Set([
  'encoding',
  'headers',
  'mapping',
  'properties',
  'variables',
])
const LITERAL_VALUE_KEYS = new Set([
  'const',
  'default',
  'enum',
])
const SUPPORTED_OPERATION_KEYS = new Set([
  'callbacks',
  'deprecated',
  'description',
  'externalDocs',
  'operationId',
  'parameters',
  'requestBody',
  'responses',
  'security',
  'servers',
  'summary',
  'tags',
])
const SUPPORTED_PATH_ITEM_KEYS = new Set([
  '$ref',
  'delete',
  'description',
  'get',
  'head',
  'options',
  'parameters',
  'patch',
  'post',
  'put',
  'servers',
  'summary',
  'trace',
])
const SCHEMA_KEYS = new Set([
  '$comment',
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'deprecated',
  'description',
  'discriminator',
  'else',
  'enum',
  'example',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'properties',
  'readOnly',
  'required',
  'then',
  'title',
  'type',
  'unevaluatedProperties',
  'uniqueItems',
  'writeOnly',
])
const SCHEMA_TYPE_NAMES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
])
const COMPOSITION_KEYS = [
  'allOf',
  'anyOf',
  'discriminator',
  'else',
  'if',
  'not',
  'oneOf',
  'then',
  'unevaluatedProperties',
]
const EXACT_SCHEMA_KEYS = [
  'default',
  'deprecated',
  'format',
  'multipleOf',
  'nullable',
  'pattern',
  'readOnly',
  'uniqueItems',
  'writeOnly',
]
const MINIMUM_SCHEMA_KEYS = [
  'exclusiveMinimum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
]
const MAXIMUM_SCHEMA_KEYS = [
  'exclusiveMaximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
]
const MAX_SCHEMA_REFERENCE_DEPTH = 128
const MAX_SCHEMA_REFERENCE_TRAVERSAL_NODES = 100_000
const SNAPSHOT_RELATIVE_PATH = 'contracts/openapi/public-api-v1.json'
const RUNTIME_SOURCE_RELATIVE_PATH = 'contracts/src/openapi.ts'
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT_PATH = resolve(REPOSITORY_ROOT, SNAPSHOT_RELATIVE_PATH)
const SCHEMA_TRAVERSAL_CONTEXTS =
  new WeakMap<IssueCollector, SchemaTraversalContext>()
const CANONICAL_RUNTIME_SOURCE = `import publicApiOpenApiDocumentJson from '../openapi/public-api-v1.json'

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
`

/**
 * Serializes a value as deterministic JSON and rejects values JSON would silently lose.
 *
 * @param value - Candidate JSON value.
 * @returns Canonical, newline-terminated JSON with lexicographically sorted object keys.
 */
export function serializeCanonicalJson(value: unknown): string {
  const normalized = normalizeJsonValue(
    value,
    '$',
    new Set(),
    {
      exceeded: false,
      visitedNodes: 0,
    },
    0,
  )
  return `${JSON.stringify(normalized, undefined, 2)}\n`
}

/**
 * Finds backward-incompatible changes from a trusted base OpenAPI document.
 *
 * New paths and methods are allowed. Existing operations are treated as stable SDK
 * surface: their operation identity, status/media/header sets, request acceptance,
 * response production, and effective security requirements remain compatible.
 *
 * @param baseDocument - Trusted OpenAPI document already exposed to consumers.
 * @param candidateDocument - Proposed OpenAPI document from the target commit.
 * @returns Immutable compatibility issues; an empty array means the change passed.
 */
export function findPublicApiCompatibilityIssues(
  baseDocument: unknown,
  candidateDocument: unknown,
): readonly PublicApiCompatibilityIssue[] {
  const issues: IssueCollector = []
  const base = requireRecord(baseDocument, '$base', issues)
  const candidate = requireRecord(candidateDocument, '$candidate', issues)
  if (!base || !candidate) return Object.freeze(deduplicateIssues(issues))
  if (!validateCandidateJsonDocument(candidate, issues)) {
    return Object.freeze(deduplicateIssues(issues))
  }
  validateCandidateDocumentShape(candidate, issues)

  compareExactSemanticValue(
    base.openapi,
    candidate.openapi,
    '$.openapi',
    'operation-contract',
    'OpenAPI specification version changed.',
    issues,
  )
  compareExactSemanticValue(
    base.jsonSchemaDialect,
    candidate.jsonSchemaDialect,
    '$.jsonSchemaDialect',
    'schema-contract',
    'JSON Schema dialect changed.',
    issues,
  )
  compareExactSemanticValue(
    base.servers,
    candidate.servers,
    '$.servers',
    'operation-contract',
    'Root server definitions changed.',
    issues,
  )

  const basePaths = requireRecord(base.paths, '$base.paths', issues)
  const candidatePaths = requireRecord(
    candidate.paths,
    '$candidate.paths',
    issues,
  )
  if (!basePaths || !candidatePaths) {
    return Object.freeze(deduplicateIssues(issues))
  }

  validateCandidatePaths(candidate, candidatePaths, issues)

  for (const [path, basePathValue] of Object.entries(basePaths)) {
    const location = `$.paths[${JSON.stringify(path)}]`
    const basePath = resolveObject(
      base,
      basePathValue,
      `${location} (base)`,
      issues,
    )
    const candidatePath = resolveObject(
      candidate,
      candidatePaths[path],
      `${location} (candidate)`,
      issues,
    )
    if (!basePath || !candidatePath) {
      if (candidatePaths[path] === undefined) {
        addIssue(
          issues,
          'operation-contract',
          location,
          'Existing API path was removed.',
        )
      }
      continue
    }
    compareExactSemanticValue(
      basePath.servers,
      candidatePath.servers,
      `${location}.servers`,
      'operation-contract',
      'Path-level server definitions changed.',
      issues,
    )

    for (const method of HTTP_METHODS) {
      const baseOperationValue = basePath[method]
      if (baseOperationValue === undefined) continue
      const operationLocation = `${location}.${method}`
      const baseOperation = requireRecord(
        baseOperationValue,
        `${operationLocation} (base)`,
        issues,
      )
      const candidateOperation = requireRecord(
        candidatePath[method],
        `${operationLocation} (candidate)`,
        issues,
      )
      if (!baseOperation) continue
      if (!candidateOperation) {
        addIssue(
          issues,
          'operation-contract',
          operationLocation,
          'Existing HTTP operation was removed.',
        )
        continue
      }
      compareOperation(
        base,
        candidate,
        basePath,
        candidatePath,
        baseOperation,
        candidateOperation,
        operationLocation,
        issues,
      )
    }
  }

  return Object.freeze(deduplicateIssues(issues))
}

/**
 * Applies canonical JSON complexity and value validation before semantic traversal.
 *
 * @param candidate - Candidate OpenAPI document.
 * @param issues - Mutable compatibility issue collector.
 * @returns Whether the candidate is bounded canonical JSON data.
 */
function validateCandidateJsonDocument(
  candidate: JsonRecord,
  issues: IssueCollector,
): boolean {
  try {
    serializeCanonicalJson(candidate)
    return true
  } catch (error) {
    addIssue(
      issues,
      'invalid-contract',
      '$candidate',
      error instanceof Error
        ? `Candidate document is not bounded JSON: ${error.message}`
        : 'Candidate document is not bounded JSON.',
    )
    return false
  }
}

/**
 * Validates required root fields and every supported Components Object entry.
 *
 * @param document - Candidate OpenAPI document.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateDocumentShape(
  document: JsonRecord,
  issues: IssueCollector,
): void {
  validateRequiredStringProperty(
    document,
    'openapi',
    '$candidate',
    'invalid-contract',
    issues,
  )
  const info = requireRecord(document.info, '$candidate.info', issues)
  if (info) {
    validateRequiredStringProperty(
      info,
      'title',
      '$candidate.info',
      'invalid-contract',
      issues,
    )
    validateRequiredStringProperty(
      info,
      'version',
      '$candidate.info',
      'invalid-contract',
      issues,
    )
  }
  if (document.security !== undefined) {
    getEffectiveSecurityContract(
      document,
      document.security,
      '$candidate.security',
      issues,
    )
  }
  validateServerArray(document.servers, '$candidate.servers', issues)
  validateCandidateComponents(document, issues)
}

/**
 * Validates supported component kinds even when no operation references them.
 *
 * @param document - Candidate OpenAPI document.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateComponents(
  document: JsonRecord,
  issues: IssueCollector,
): void {
  const components = optionalRecord(
    document.components,
    '$candidate.components',
    issues,
  )
  if (!components) return

  const schemas = optionalRecord(
    components.schemas,
    '$candidate.components.schemas',
    issues,
  )
  if (schemas) {
    for (const [name, schema] of Object.entries(schemas)) {
      validateSchemaReferences(
        document,
        schema,
        `$.components.schemas[${JSON.stringify(name)}]`,
        issues,
      )
    }
  }

  const responses = optionalRecord(
    components.responses,
    '$candidate.components.responses',
    issues,
  )
  if (responses) {
    for (const [name, responseValue] of Object.entries(responses)) {
      validateCandidateResponseObject(
        document,
        responseValue,
        `$.components.responses[${JSON.stringify(name)}]`,
        issues,
      )
    }
  }

  const headers = optionalRecord(
    components.headers,
    '$candidate.components.headers',
    issues,
  )
  if (headers) {
    for (const [name, headerValue] of Object.entries(headers)) {
      validateCandidateHeaderObject(
        document,
        headerValue,
        `$.components.headers[${JSON.stringify(name)}]`,
        'response',
        issues,
      )
    }
  }

  const parameters = optionalRecord(
    components.parameters,
    '$candidate.components.parameters',
    issues,
  )
  if (parameters) {
    for (const [name, parameterValue] of Object.entries(parameters)) {
      validateCandidateParameterObject(
        document,
        parameterValue,
        `$.components.parameters[${JSON.stringify(name)}]`,
        issues,
      )
    }
  }

  const requestBodies = optionalRecord(
    components.requestBodies,
    '$candidate.components.requestBodies',
    issues,
  )
  if (requestBodies) {
    for (const [name, requestBodyValue] of Object.entries(requestBodies)) {
      validateCandidateRequestBodyObject(
        document,
        requestBodyValue,
        `$.components.requestBodies[${JSON.stringify(name)}]`,
        issues,
      )
    }
  }

  const securitySchemes = optionalRecord(
    components.securitySchemes,
    '$candidate.components.securitySchemes',
    issues,
  )
  if (securitySchemes) {
    for (const [name, schemeValue] of Object.entries(securitySchemes)) {
      validateCandidateSecurityScheme(
        document,
        schemeValue,
        `$.components.securitySchemes[${JSON.stringify(name)}]`,
        issues,
      )
    }
  }

  const pathItems = optionalRecord(
    components.pathItems,
    '$candidate.components.pathItems',
    issues,
  )
  if (pathItems) {
    for (const [name, pathItemValue] of Object.entries(pathItems)) {
      validateCandidateComponentPathItem(
        document,
        pathItemValue,
        `$.components.pathItems[${JSON.stringify(name)}]`,
        new Map(),
        issues,
      )
    }
  }

  for (const unsupportedKind of ['callbacks', 'links']) {
    if (components[unsupportedKind] !== undefined) {
      addIssue(
        issues,
        'invalid-contract',
        `$.components.${unsupportedKind}`,
        `Component kind ${unsupportedKind} is not supported by the compatibility checker.`,
      )
    }
  }
}

/**
 * Validates an unreferenced Path Item component and all operations it owns.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Path Item Object or local reference.
 * @param location - Component diagnostic location.
 * @param operationIds - Operation IDs already observed in Path Item components.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateComponentPathItem(
  document: JsonRecord,
  value: unknown,
  location: string,
  operationIds: Map<string, string>,
  issues: IssueCollector,
): void {
  const pathItem = resolveObject(document, value, location, issues)
  if (!pathItem) return
  validateOptionalStringProperty(
    pathItem,
    'description',
    location,
    'operation-contract',
    issues,
  )
  validateOptionalStringProperty(
    pathItem,
    'summary',
    location,
    'operation-contract',
    issues,
  )
  validateServerArray(pathItem.servers, `${location}.servers`, issues)
  validateCandidateParameterArray(
    document,
    pathItem.parameters,
    `${location}.parameters`,
    issues,
  )
  for (const key of Object.keys(pathItem)) {
    if (!SUPPORTED_PATH_ITEM_KEYS.has(key)) {
      addIssue(
        issues,
        'operation-contract',
        `${location}.${key}`,
        `Unsupported Path Item keyword ${JSON.stringify(key)} cannot be introduced.`,
      )
    }
  }
  for (const method of HTTP_METHODS) {
    const operationValue = pathItem[method]
    if (operationValue === undefined) continue
    const operationLocation = `${location}.${method}`
    const operation = requireRecord(
      operationValue,
      operationLocation,
      issues,
    )
    if (!operation) continue
    validateCandidateOperationShape(
      document,
      operation,
      operationLocation,
      operationIds,
      issues,
    )
    for (const key of Object.keys(operation)) {
      if (!SUPPORTED_OPERATION_KEYS.has(key)) {
        addIssue(
          issues,
          'operation-contract',
          `${operationLocation}.${key}`,
          `Unsupported operation keyword ${JSON.stringify(key)} cannot be introduced.`,
        )
      }
    }
    if (operation.callbacks !== undefined) {
      addIssue(
        issues,
        'operation-contract',
        `${operationLocation}.callbacks`,
        'Callbacks are not supported by the compatibility checker.',
      )
    }
  }
}

/**
 * Validates every candidate operation, including operations with no base counterpart.
 *
 * @param document - Candidate OpenAPI document.
 * @param paths - Candidate Paths Object.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidatePaths(
  document: JsonRecord,
  paths: JsonRecord,
  issues: IssueCollector,
): void {
  const operationIds = new Map<string, string>()
  const normalizedTemplates = new Map<string, string>()
  for (const [path, pathValue] of Object.entries(paths)) {
    const location = `$.paths[${JSON.stringify(path)}]`
    if (!path.startsWith('/')) {
      addIssue(
        issues,
        'operation-contract',
        location,
        'Path template keys must begin with "/".',
      )
    }
    const parsedTemplate = parsePathTemplate(path)
    if (!parsedTemplate) {
      addIssue(
        issues,
        'operation-contract',
        location,
        'Path templates must contain only balanced, non-empty parameter expressions.',
      )
    } else {
      const existingTemplate = normalizedTemplates.get(
        parsedTemplate.normalized,
      )
      if (existingTemplate !== undefined && existingTemplate !== path) {
        addIssue(
          issues,
          'operation-contract',
          location,
          `Path template is ambiguous with ${JSON.stringify(existingTemplate)}.`,
        )
      } else {
        normalizedTemplates.set(parsedTemplate.normalized, path)
      }
    }
    const pathItem = resolveObject(
      document,
      pathValue,
      `${location} (candidate validation)`,
      issues,
    )
    if (!pathItem) continue
    validateOptionalStringProperty(
      pathItem,
      'description',
      location,
      'operation-contract',
      issues,
    )
    validateOptionalStringProperty(
      pathItem,
      'summary',
      location,
      'operation-contract',
      issues,
    )
    validateServerArray(pathItem.servers, `${location}.servers`, issues)
    validateCandidateParameterArray(
      document,
      pathItem.parameters,
      `${location}.parameters`,
      issues,
    )
    for (const key of Object.keys(pathItem)) {
      if (!SUPPORTED_PATH_ITEM_KEYS.has(key)) {
        addIssue(
          issues,
          'operation-contract',
          `${location}.${key}`,
          `Unsupported Path Item keyword ${JSON.stringify(key)} cannot be introduced.`,
        )
      }
    }
    for (const method of HTTP_METHODS) {
      const operationValue = pathItem[method]
      if (operationValue === undefined) continue
      const operationLocation = `${location}.${method}`
      const operation = requireRecord(
        operationValue,
        `${operationLocation} (candidate validation)`,
        issues,
      )
      if (!operation) continue
      validateCandidateOperationShape(
        document,
        operation,
        operationLocation,
        operationIds,
        issues,
      )
      validatePathTemplateParameters(
        document,
        path,
        pathItem,
        operation,
        operationLocation,
        issues,
      )
      for (const key of Object.keys(operation)) {
        if (!SUPPORTED_OPERATION_KEYS.has(key)) {
          addIssue(
            issues,
            'operation-contract',
            `${operationLocation}.${key}`,
            `Unsupported operation keyword ${JSON.stringify(key)} cannot be introduced.`,
          )
        }
      }
      if (operation.callbacks !== undefined) {
        addIssue(
          issues,
          'operation-contract',
          `${operationLocation}.callbacks`,
          'Callbacks are not supported by the compatibility checker.',
        )
      }
    }
  }
}

/**
 * Validates effective path parameters against placeholders in a path template.
 *
 * @param document - Candidate OpenAPI document.
 * @param path - Candidate path template.
 * @param pathItem - Candidate Path Item Object.
 * @param operation - Candidate Operation Object.
 * @param location - Operation diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validatePathTemplateParameters(
  document: JsonRecord,
  path: string,
  pathItem: JsonRecord,
  operation: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const parsedTemplate = parsePathTemplate(path)
  if (!parsedTemplate) return
  const placeholders = new Set(parsedTemplate.placeholders)
  const parameters = collectParameters(
    document,
    pathItem.parameters,
    operation.parameters,
    `${location}.effectiveParameters`,
    issues,
  )
  for (const placeholder of placeholders) {
    const parameter = parameters.get(`path\u0000${placeholder}`)
    if (!parameter || parameter.value.required !== true) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}.parameters[${JSON.stringify(placeholder)}]`,
        'Every path placeholder requires a matching required path parameter.',
      )
    }
  }
  for (const parameter of parameters.values()) {
    if (
      parameter.inputLocation === 'path' &&
      !placeholders.has(parameter.name)
    ) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}.parameters[${JSON.stringify(parameter.name)}]`,
        'Path parameter does not match a path-template placeholder.',
      )
    }
  }
}

/**
 * Parses one path template and produces a name-independent hierarchy key.
 *
 * @param path - Candidate OpenAPI path key.
 * @returns Parsed template, or undefined for unmatched, nested, or empty braces.
 */
function parsePathTemplate(path: string): ParsedPathTemplate | undefined {
  const placeholders: string[] = []
  let normalized = ''
  let cursor = 0
  while (cursor < path.length) {
    const character = path[cursor]
    if (character === '}') return undefined
    if (character !== '{') {
      normalized += character
      cursor += 1
      continue
    }
    const closingBrace = path.indexOf('}', cursor + 1)
    if (closingBrace < 0) return undefined
    const placeholder = path.slice(cursor + 1, closingBrace)
    if (placeholder.length === 0 || placeholder.includes('{')) {
      return undefined
    }
    placeholders.push(placeholder)
    normalized += '{}'
    cursor = closingBrace + 1
  }
  return { normalized, placeholders }
}

/**
 * Validates fields owned directly by one candidate Operation Object.
 *
 * @param document - Candidate OpenAPI document.
 * @param operation - Candidate operation.
 * @param location - Operation diagnostic location.
 * @param operationIds - Operation IDs already observed in the candidate.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateOperationShape(
  document: JsonRecord,
  operation: JsonRecord,
  location: string,
  operationIds: Map<string, string>,
  issues: IssueCollector,
): void {
  validateOptionalStringProperty(
    operation,
    'description',
    location,
    'operation-contract',
    issues,
  )
  validateOptionalStringProperty(
    operation,
    'summary',
    location,
    'operation-contract',
    issues,
  )
  validateOptionalStringProperty(
    operation,
    'operationId',
    location,
    'operation-contract',
    issues,
  )
  validateOptionalBooleanProperty(
    operation,
    'deprecated',
    location,
    'operation-contract',
    issues,
  )
  validateOptionalStringArrayProperty(
    operation,
    'tags',
    location,
    'operation-contract',
    issues,
  )
  if (typeof operation.operationId === 'string') {
    const previousLocation = operationIds.get(operation.operationId)
    if (previousLocation) {
      addIssue(
        issues,
        'operation-contract',
        `${location}.operationId`,
        `operationId duplicates the operation at ${previousLocation}.`,
      )
    } else {
      operationIds.set(operation.operationId, location)
    }
  }
  validateServerArray(operation.servers, `${location}.servers`, issues)
  if (operation.security !== undefined) {
    getEffectiveSecurityContract(
      document,
      operation.security,
      `${location}.security`,
      issues,
    )
  }
  validateCandidateParameterArray(
    document,
    operation.parameters,
    `${location}.parameters`,
    issues,
  )
  if (operation.requestBody !== undefined) {
    validateCandidateRequestBodyObject(
      document,
      operation.requestBody,
      `${location}.requestBody`,
      issues,
    )
  }
  validateCandidateResponsesObject(
    document,
    operation.responses,
    `${location}.responses`,
    issues,
  )
}

/**
 * Validates a candidate Request Body Object or local reference.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Request body object or reference.
 * @param location - Request body diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateRequestBodyObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const requestBody = resolveObject(document, value, location, issues)
  if (!requestBody) return
  validateOptionalStringProperty(
    requestBody,
    'description',
    location,
    'request-contract',
    issues,
  )
  validateOptionalBooleanProperty(
    requestBody,
    'required',
    location,
    'request-contract',
    issues,
  )
  validateCandidateContentObject(
    document,
    requestBody.content,
    `${location}.content`,
    'request',
    true,
    issues,
  )
}

/**
 * Validates the required, non-empty Responses Object for one operation.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Candidate Responses Object.
 * @param location - Responses diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateResponsesObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const responses = requireRecord(value, location, issues)
  if (!responses) return
  if (Object.keys(responses).length === 0) {
    addIssue(
      issues,
      'response-contract',
      location,
      'Operation responses must contain at least one response.',
    )
  }
  for (const [status, responseValue] of Object.entries(responses)) {
    if (
      status !== 'default' &&
      !/^[1-5](?:[0-9]{2}|XX)$/.test(status)
    ) {
      addIssue(
        issues,
        'response-contract',
        `${location}[${JSON.stringify(status)}]`,
        'Response keys must be default, a three-digit status, or an X wildcard.',
      )
    }
    validateCandidateResponseObject(
      document,
      responseValue,
      `${location}[${JSON.stringify(status)}]`,
      issues,
    )
  }
}

/**
 * Validates one candidate Response Object or local reference.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Response object or reference.
 * @param location - Response diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateResponseObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const response = resolveObject(document, value, location, issues)
  if (!response) return
  validateRequiredStringProperty(
    response,
    'description',
    location,
    'response-contract',
    issues,
  )
  if (response.links !== undefined) {
    addIssue(
      issues,
      'response-contract',
      `${location}.links`,
      'Response links are not supported by the compatibility checker.',
    )
  }
  const headers = optionalRecord(
    response.headers,
    `${location}.headers`,
    issues,
  )
  if (headers) {
    for (const [name, headerValue] of Object.entries(headers)) {
      validateCandidateHeaderObject(
        document,
        headerValue,
        `${location}.headers[${JSON.stringify(name)}]`,
        'response',
        issues,
      )
    }
  }
  if (response.content !== undefined) {
    validateCandidateContentObject(
      document,
      response.content,
      `${location}.content`,
      'response',
      false,
      issues,
    )
  }
}

/**
 * Validates one candidate Header Object or local reference.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Header object or reference.
 * @param location - Header diagnostic location.
 * @param direction - Boundary direction for the header value.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateHeaderObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  direction: SchemaDirection,
  issues: IssueCollector,
): void {
  const header = resolveObject(document, value, location, issues)
  if (!header) return
  const rule = direction === 'request'
    ? 'request-contract'
    : 'response-contract'
  validateOptionalStringProperty(
    header,
    'description',
    location,
    rule,
    issues,
  )
  validateOptionalStringProperty(
    header,
    'style',
    location,
    rule,
    issues,
  )
  for (const property of ['deprecated', 'explode', 'required']) {
    validateOptionalBooleanProperty(
      header,
      property,
      location,
      rule,
      issues,
    )
  }
  const hasSchema = Object.hasOwn(header, 'schema')
  const hasContent = Object.hasOwn(header, 'content')
  if (hasSchema === hasContent) {
    addIssue(
      issues,
      rule,
      location,
      'Header must define exactly one of schema or content.',
    )
  }
  if (hasSchema) {
    validateSchemaReferences(
      document,
      header.schema,
      `${location}.schema`,
      issues,
    )
  }
  if (hasContent) {
    const content = validateCandidateContentObject(
      document,
      header.content,
      `${location}.content`,
      direction,
      true,
      issues,
    )
    if (content && Object.keys(content).length !== 1) {
      addIssue(
        issues,
        rule,
        `${location}.content`,
        'Header content must define exactly one media type.',
      )
    }
  }
}

/**
 * Validates a candidate parameter array and each referenced Parameter Object.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Optional parameter array.
 * @param location - Parameter-array diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateParameterArray(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      'parameter-contract',
      location,
      'Parameters must be an array.',
    )
    return
  }
  for (const [index, parameterValue] of value.entries()) {
    validateCandidateParameterObject(
      document,
      parameterValue,
      `${location}[${index}]`,
      issues,
    )
  }
}

/**
 * Validates one candidate Parameter Object or local reference.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Parameter object or reference.
 * @param location - Parameter diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateParameterObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const parameter = resolveObject(document, value, location, issues)
  if (!parameter) return
  validateRequiredStringProperty(
    parameter,
    'name',
    location,
    'parameter-contract',
    issues,
  )
  validateRequiredStringProperty(
    parameter,
    'in',
    location,
    'parameter-contract',
    issues,
  )
  validateOptionalStringProperty(
    parameter,
    'description',
    location,
    'parameter-contract',
    issues,
  )
  validateOptionalStringProperty(
    parameter,
    'style',
    location,
    'parameter-contract',
    issues,
  )
  for (
    const property of [
      'allowEmptyValue',
      'allowReserved',
      'deprecated',
      'explode',
      'required',
    ]
  ) {
    validateOptionalBooleanProperty(
      parameter,
      property,
      location,
      'parameter-contract',
      issues,
    )
  }
  const inputLocation = parameter.in
  if (
    typeof inputLocation === 'string' &&
    inputLocation !== 'cookie' &&
    inputLocation !== 'header' &&
    inputLocation !== 'path' &&
    inputLocation !== 'query'
  ) {
    addIssue(
      issues,
      'parameter-contract',
      `${location}.in`,
      'Parameter in must be cookie, header, path, or query.',
    )
  }
  if (inputLocation === 'path' && parameter.required !== true) {
    addIssue(
      issues,
      'parameter-contract',
      `${location}.required`,
      'Path parameters must declare required: true.',
    )
  }
  const hasSchema = Object.hasOwn(parameter, 'schema')
  const hasContent = Object.hasOwn(parameter, 'content')
  if (hasSchema === hasContent) {
    addIssue(
      issues,
      'parameter-contract',
      location,
      'Parameter must define exactly one of schema or content.',
    )
  }
  if (hasSchema) {
    validateSchemaReferences(
      document,
      parameter.schema,
      `${location}.schema`,
      issues,
    )
  }
  if (hasContent) {
    const content = validateCandidateContentObject(
      document,
      parameter.content,
      `${location}.content`,
      'request',
      true,
      issues,
    )
    if (content && Object.keys(content).length !== 1) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}.content`,
        'Parameter content must define exactly one media type.',
      )
    }
  }
}

/**
 * Validates a Content Object and the schema of every Media Type Object.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Content Object value.
 * @param location - Content diagnostic location.
 * @param direction - Boundary direction for contained schemas.
 * @param required - Whether omission or an empty map is invalid.
 * @param issues - Mutable compatibility issue collector.
 * @returns Validated Content Object, when present and object-shaped.
 */
function validateCandidateContentObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  direction: SchemaDirection,
  required: boolean,
  issues: IssueCollector,
): JsonRecord | undefined {
  if (value === undefined && !required) return undefined
  const content = requireRecord(value, location, issues)
  if (!content) return undefined
  if (required && Object.keys(content).length === 0) {
    addIssue(
      issues,
      direction === 'request' ? 'request-contract' : 'response-contract',
      location,
      'Content must define at least one media type.',
    )
  }
  for (const [mediaType, mediaValue] of Object.entries(content)) {
    const mediaLocation = `${location}[${JSON.stringify(mediaType)}]`
    const media = requireRecord(mediaValue, mediaLocation, issues)
    if (!media) continue
    if (media.schema !== undefined) {
      validateSchemaReferences(
        document,
        media.schema,
        `${mediaLocation}.schema`,
        issues,
      )
    }
    const encoding = optionalRecord(
      media.encoding,
      `${mediaLocation}.encoding`,
      issues,
    )
    if (!encoding) continue
    for (const [property, encodingValue] of Object.entries(encoding)) {
      const encodingLocation =
        `${mediaLocation}.encoding[${JSON.stringify(property)}]`
      const encodingObject = requireRecord(
        encodingValue,
        encodingLocation,
        issues,
      )
      if (!encodingObject) continue
      validateOptionalStringProperty(
        encodingObject,
        'contentType',
        encodingLocation,
        direction === 'request' ? 'request-contract' : 'response-contract',
        issues,
      )
      validateOptionalStringProperty(
        encodingObject,
        'style',
        encodingLocation,
        direction === 'request' ? 'request-contract' : 'response-contract',
        issues,
      )
      for (const booleanProperty of ['allowReserved', 'explode']) {
        validateOptionalBooleanProperty(
          encodingObject,
          booleanProperty,
          encodingLocation,
          direction === 'request' ? 'request-contract' : 'response-contract',
          issues,
        )
      }
      const encodingHeaders = optionalRecord(
        encodingObject.headers,
        `${encodingLocation}.headers`,
        issues,
      )
      if (encodingHeaders) {
        for (const [headerName, headerValue] of Object.entries(
          encodingHeaders,
        )) {
          const headerLocation =
            `${encodingLocation}.headers[${JSON.stringify(headerName)}]`
          if (headerName.toLowerCase() === 'content-type') {
            addIssue(
              issues,
              direction === 'request'
                ? 'request-contract'
                : 'response-contract',
              headerLocation,
              'Encoding headers must not redefine Content-Type.',
            )
          }
          validateCandidateHeaderObject(
            document,
            headerValue,
            headerLocation,
            direction,
            issues,
          )
        }
      }
    }
  }
  return content
}

/**
 * Validates the required discriminator fields of one security scheme.
 *
 * @param document - Candidate OpenAPI document.
 * @param value - Security Scheme Object or local reference.
 * @param location - Security-scheme diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateSecurityScheme(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const scheme = resolveObject(document, value, location, issues)
  if (!scheme) return
  validateRequiredStringProperty(
    scheme,
    'type',
    location,
    'security-contract',
    issues,
  )
  validateOptionalStringProperty(
    scheme,
    'description',
    location,
    'security-contract',
    issues,
  )
  if (scheme.type === 'http') {
    validateRequiredStringProperty(
      scheme,
      'scheme',
      location,
      'security-contract',
      issues,
    )
    validateOptionalStringProperty(
      scheme,
      'bearerFormat',
      location,
      'security-contract',
      issues,
    )
  } else if (scheme.type === 'apiKey') {
    validateRequiredStringProperty(
      scheme,
      'name',
      location,
      'security-contract',
      issues,
    )
    validateRequiredStringProperty(
      scheme,
      'in',
      location,
      'security-contract',
      issues,
    )
    if (
      typeof scheme.in === 'string' &&
      scheme.in !== 'cookie' &&
      scheme.in !== 'header' &&
      scheme.in !== 'query'
    ) {
      addIssue(
        issues,
        'security-contract',
        `${location}.in`,
        'API key security scheme in must be cookie, header, or query.',
      )
    }
  } else if (scheme.type === 'oauth2') {
    const flows = requireRecord(scheme.flows, `${location}.flows`, issues)
    if (flows) {
      if (Object.keys(flows).length === 0) {
        addIssue(
          issues,
          'security-contract',
          `${location}.flows`,
          'OAuth2 flows must contain at least one flow.',
        )
      }
      for (const [flowName, flowValue] of Object.entries(flows)) {
        validateCandidateOAuthFlow(
          flowName,
          flowValue,
          `${location}.flows.${flowName}`,
          issues,
        )
      }
    }
  } else if (scheme.type === 'openIdConnect') {
    validateRequiredStringProperty(
      scheme,
      'openIdConnectUrl',
      location,
      'security-contract',
      issues,
    )
  } else if (scheme.type !== 'mutualTLS') {
    addIssue(
      issues,
      'security-contract',
      `${location}.type`,
      'Security scheme type is not supported.',
    )
  }
}

/**
 * Validates one supported OAuth Flow Object.
 *
 * @param flowName - OAuth flow discriminator.
 * @param value - Candidate OAuth Flow Object.
 * @param location - Flow diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateCandidateOAuthFlow(
  flowName: string,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const flow = requireRecord(value, location, issues)
  if (!flow) return
  if (
    flowName !== 'authorizationCode' &&
    flowName !== 'clientCredentials' &&
    flowName !== 'implicit' &&
    flowName !== 'password'
  ) {
    addIssue(
      issues,
      'security-contract',
      location,
      'OAuth2 flow type is not supported.',
    )
    return
  }
  if (flowName === 'authorizationCode' || flowName === 'implicit') {
    validateRequiredStringProperty(
      flow,
      'authorizationUrl',
      location,
      'security-contract',
      issues,
    )
  }
  if (
    flowName === 'authorizationCode' ||
    flowName === 'clientCredentials' ||
    flowName === 'password'
  ) {
    validateRequiredStringProperty(
      flow,
      'tokenUrl',
      location,
      'security-contract',
      issues,
    )
  }
  validateOptionalStringProperty(
    flow,
    'refreshUrl',
    location,
    'security-contract',
    issues,
  )
  const scopes = requireRecord(flow.scopes, `${location}.scopes`, issues)
  if (!scopes) return
  for (const [scope, description] of Object.entries(scopes)) {
    if (typeof description !== 'string') {
      addIssue(
        issues,
        'security-contract',
        `${location}.scopes[${JSON.stringify(scope)}]`,
        'OAuth2 scope descriptions must be strings.',
      )
    }
  }
}

/**
 * Validates a Server Object array and its required URL fields.
 *
 * @param value - Optional server array.
 * @param location - Server-array diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateServerArray(
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      'operation-contract',
      location,
      'Servers must be an array.',
    )
    return
  }
  for (const [index, serverValue] of value.entries()) {
    const serverLocation = `${location}[${index}]`
    const server = requireRecord(serverValue, serverLocation, issues)
    if (!server) continue
    validateRequiredStringProperty(
      server,
      'url',
      serverLocation,
      'operation-contract',
      issues,
    )
    validateOptionalStringProperty(
      server,
      'description',
      serverLocation,
      'operation-contract',
      issues,
    )
    const variables = optionalRecord(
      server.variables,
      `${serverLocation}.variables`,
      issues,
    )
    if (!variables) continue
    for (const [name, variableValue] of Object.entries(variables)) {
      const variableLocation =
        `${serverLocation}.variables[${JSON.stringify(name)}]`
      const variable = requireRecord(
        variableValue,
        variableLocation,
        issues,
      )
      if (!variable) continue
      if (!Object.hasOwn(variable, 'default')) {
        addIssue(
          issues,
          'operation-contract',
          `${variableLocation}.default`,
          'Server variable default is required.',
        )
      }
      validateOptionalStringProperty(
        variable,
        'description',
        variableLocation,
        'operation-contract',
        issues,
      )
      validateOptionalStringArrayProperty(
        variable,
        'enum',
        variableLocation,
        'operation-contract',
        issues,
      )
    }
  }
}

/**
 * Compares one existing HTTP operation and every consumer-visible boundary it owns.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param basePath - Base path item containing inherited parameters.
 * @param candidatePath - Candidate path item containing inherited parameters.
 * @param baseOperation - Base operation object.
 * @param candidateOperation - Candidate operation object.
 * @param location - Stable operation diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function compareOperation(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  basePath: JsonRecord,
  candidatePath: JsonRecord,
  baseOperation: JsonRecord,
  candidateOperation: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  compareExactSemanticValue(
    baseOperation.operationId,
    candidateOperation.operationId,
    `${location}.operationId`,
    'operation-contract',
    'Existing operationId changed.',
    issues,
  )
  compareExactSemanticValue(
    baseOperation.deprecated ?? false,
    candidateOperation.deprecated ?? false,
    `${location}.deprecated`,
    'operation-contract',
    'Existing operation deprecation contract changed.',
    issues,
  )
  compareExactSemanticValue(
    baseOperation.servers,
    candidateOperation.servers,
    `${location}.servers`,
    'operation-contract',
    'Operation server definitions changed.',
    issues,
  )
  compareExactSemanticValue(
    baseOperation.callbacks,
    candidateOperation.callbacks,
    `${location}.callbacks`,
    'operation-contract',
    'Operation callback contract changed.',
    issues,
  )
  compareUnknownOperationKeys(baseOperation, candidateOperation, location, issues)
  compareEffectiveSecurity(
    baseDocument,
    candidateDocument,
    baseOperation,
    candidateOperation,
    location,
    issues,
  )
  compareParameters(
    baseDocument,
    candidateDocument,
    basePath,
    candidatePath,
    baseOperation,
    candidateOperation,
    location,
    issues,
  )
  compareRequestBody(
    baseDocument,
    candidateDocument,
    baseOperation.requestBody,
    candidateOperation.requestBody,
    `${location}.requestBody`,
    issues,
  )
  compareResponses(
    baseDocument,
    candidateDocument,
    baseOperation.responses,
    candidateOperation.responses,
    `${location}.responses`,
    issues,
  )
}

/**
 * Fails closed when an operation-level keyword outside the supported contract changes.
 *
 * @param base - Base operation.
 * @param candidate - Candidate operation.
 * @param location - Operation diagnostic location.
 * @param issues - Mutable issue collector.
 */
function compareUnknownOperationKeys(
  base: JsonRecord,
  candidate: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const unknownKeys = new Set([
    ...Object.keys(base).filter((key) => !SUPPORTED_OPERATION_KEYS.has(key)),
    ...Object.keys(candidate).filter(
      (key) => !SUPPORTED_OPERATION_KEYS.has(key),
    ),
  ])
  for (const key of unknownKeys) {
    compareExactSemanticValue(
      base[key],
      candidate[key],
      `${location}.${key}`,
      'operation-contract',
      `Unsupported operation keyword ${JSON.stringify(key)} changed.`,
      issues,
    )
  }
}

/**
 * Compares effective root/operation security and referenced scheme definitions.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseOperation - Base operation.
 * @param candidateOperation - Candidate operation.
 * @param location - Operation location.
 * @param issues - Mutable issue collector.
 */
function compareEffectiveSecurity(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseOperation: JsonRecord,
  candidateOperation: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const baseSecurity = Object.hasOwn(baseOperation, 'security')
    ? baseOperation.security
    : baseDocument.security
  const candidateSecurity = Object.hasOwn(candidateOperation, 'security')
    ? candidateOperation.security
    : candidateDocument.security
  const baseContract = getEffectiveSecurityContract(
    baseDocument,
    baseSecurity,
    `${location}.security (base)`,
    issues,
  )
  const candidateContract = getEffectiveSecurityContract(
    candidateDocument,
    candidateSecurity,
    `${location}.security (candidate)`,
    issues,
  )
  if (!baseContract.valid || !candidateContract.valid) return
  if (
    baseContract.requirementsDigest !== candidateContract.requirementsDigest
  ) {
    addIssue(
      issues,
      'security-contract',
      `${location}.security`,
      'Effective security requirements changed.',
    )
    return
  }
  if (baseContract.schemesDigest !== candidateContract.schemesDigest) {
    addIssue(
      issues,
      'security-contract',
      `${location}.securitySchemes`,
      'Referenced security scheme definition changed.',
    )
  }
}

/**
 * Returns a fixed-size, run-cached effective security contract.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Effective root- or operation-level security value.
 * @param location - Stable diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Tagged effective-security contract.
 */
function getEffectiveSecurityContract(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): EffectiveSecurityContract {
  const traversalContext = getSchemaTraversalContext(issues)
  if (value === undefined) {
    const cached = traversalContext.omittedSecurityContracts.get(document)
    if (cached) return cached
  } else if (typeof value === 'object' && value !== null) {
    const documentCache = traversalContext.securityContracts.get(document)
    const cached = documentCache?.get(value)
    if (cached) return cached
  }

  const normalized = normalizeSecurity(value, location, issues)
  const requirementValue = normalized.value ?? null
  const schemeFingerprints: Record<string, unknown> = {}
  let valid = normalized.valid
  for (const schemeName of collectSecuritySchemeNames(normalized.value)) {
    const fingerprint = getSecuritySchemeFingerprint(
      document,
      schemeName,
      `${location}.securitySchemes.${schemeName}`,
      issues,
    )
    valid &&= fingerprint.valid
    defineRecordProperty(
      schemeFingerprints,
      schemeName,
      fingerprint.digest ?? null,
    )
  }
  const requirementsDigest = createSemanticDigest(requirementValue)
  const schemesDigest = createSemanticDigest(schemeFingerprints)
  if (!requirementsDigest || !schemesDigest) valid = false
  const contract: EffectiveSecurityContract = {
    requirementsDigest: requirementsDigest ?? '',
    schemesDigest: schemesDigest ?? '',
    valid,
  }

  if (value === undefined) {
    traversalContext.omittedSecurityContracts.set(document, contract)
  } else if (typeof value === 'object' && value !== null) {
    let documentCache = traversalContext.securityContracts.get(document)
    if (!documentCache) {
      documentCache = new WeakMap()
      traversalContext.securityContracts.set(document, documentCache)
    }
    documentCache.set(value, contract)
  }
  return contract
}

/**
 * Returns a cached semantic digest for one referenced security scheme.
 *
 * @param document - Owning OpenAPI document.
 * @param schemeName - Referenced Security Scheme component name.
 * @param location - Stable diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Tagged scheme fingerprint.
 */
function getSecuritySchemeFingerprint(
  document: JsonRecord,
  schemeName: string,
  location: string,
  issues: IssueCollector,
): SecuritySchemeFingerprint {
  const traversalContext = getSchemaTraversalContext(issues)
  let fingerprints = traversalContext.securitySchemeFingerprints.get(document)
  if (!fingerprints) {
    fingerprints = new Map()
    traversalContext.securitySchemeFingerprints.set(document, fingerprints)
  }
  const cached = fingerprints.get(schemeName)
  if (cached) return cached
  const scheme = resolveComponentObject(
    document,
    ['components', 'securitySchemes', schemeName],
    location,
    issues,
  )
  const digest = scheme
    ? createSemanticDigest(normalizeSecurityScheme(scheme))
    : undefined
  const fingerprint: SecuritySchemeFingerprint = {
    digest,
    valid: scheme !== undefined && digest !== undefined,
  }
  fingerprints.set(schemeName, fingerprint)
  return fingerprint
}

/**
 * Creates a fixed-size digest for a canonical semantic value.
 *
 * @param value - JSON-compatible semantic value.
 * @returns SHA-256 digest, or undefined when canonicalization fails.
 */
function createSemanticDigest(value: unknown): string | undefined {
  try {
    return createHash('sha256')
      .update(serializeCanonicalJson(value))
      .digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Normalizes security requirements as an unordered OR of unordered scheme sets.
 *
 * @param value - Effective OpenAPI security value.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Tagged canonical security alternatives.
 */
function normalizeSecurity(
  value: unknown,
  location: string,
  issues: IssueCollector,
): NormalizedSecurityResult {
  if (value === undefined) return { valid: true, value: undefined }
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      'security-contract',
      location,
      'Effective security must be an array.',
    )
    return { valid: false, value: undefined }
  }
  const alternatives: unknown[] = []
  let valid = true
  for (const [index, requirementValue] of value.entries()) {
    const requirement = requireRecord(
      requirementValue,
      `${location}[${index}]`,
      issues,
    )
    if (!requirement) {
      valid = false
      continue
    }
    const normalized: Record<string, unknown> = {}
    for (const scheme of Object.keys(requirement).sort()) {
      const scopes = requirement[scheme]
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
        addIssue(
          issues,
          'security-contract',
          `${location}[${index}].${scheme}`,
          'Security scopes must be an array of strings.',
        )
        valid = false
        continue
      }
      defineRecordProperty(normalized, scheme, [...new Set(scopes)].sort())
    }
    alternatives.push(normalized)
  }
  const decorated = alternatives.map((alternative) => ({
    alternative,
    canonical: serializeCanonicalJson(alternative),
  }))
  decorated.sort((left, right) =>
    left.canonical.localeCompare(right.canonical))
  return {
    valid,
    value: Object.freeze(
      decorated.map((entry) => entry.alternative),
    ),
  }
}

/**
 * Collects every scheme referenced by normalized security alternatives.
 *
 * @param security - Normalized security alternatives.
 * @returns Stable unique security scheme names.
 */
function collectSecuritySchemeNames(
  security: readonly unknown[] | undefined,
): readonly string[] {
  if (!security) return []
  const names = new Set<string>()
  for (const requirement of security) {
    if (!isJsonRecord(requirement)) continue
    for (const name of Object.keys(requirement)) names.add(name)
  }
  return [...names].sort()
}

/**
 * Removes annotations while retaining security protocol and OAuth scope names.
 *
 * @param scheme - Resolved security scheme.
 * @returns Canonical semantic security scheme value.
 */
function normalizeSecurityScheme(scheme: JsonRecord): unknown {
  return stripSecurityAnnotations(scheme, false)
}

/**
 * Recursively removes security description text without losing scope identities.
 *
 * @param value - Security scheme fragment.
 * @param scopesMap - Whether the current object maps OAuth scope names to descriptions.
 * @returns Semantic security fragment.
 */
function stripSecurityAnnotations(value: unknown, scopesMap: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSecurityAnnotations(entry, false))
  }
  if (!isJsonRecord(value)) return scopesMap ? true : value
  const normalized: Record<string, unknown> = {}
  if (scopesMap) {
    for (const key of Object.keys(value).sort()) {
      defineRecordProperty(normalized, key, true)
    }
    return normalized
  }
  for (const key of Object.keys(value).sort()) {
    if (ANNOTATION_KEYS.has(key)) continue
    defineRecordProperty(
      normalized,
      key,
      stripSecurityAnnotations(value[key], key === 'scopes'),
    )
  }
  return normalized
}

/**
 * Compares merged path-level and operation-level parameters.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param basePath - Base path item.
 * @param candidatePath - Candidate path item.
 * @param baseOperation - Base operation.
 * @param candidateOperation - Candidate operation.
 * @param location - Operation location.
 * @param issues - Mutable issue collector.
 */
function compareParameters(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  basePath: JsonRecord,
  candidatePath: JsonRecord,
  baseOperation: JsonRecord,
  candidateOperation: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const baseParameters = collectParameters(
    baseDocument,
    basePath.parameters,
    baseOperation.parameters,
    `${location}.parameters (base)`,
    issues,
  )
  const candidateParameters = collectParameters(
    candidateDocument,
    candidatePath.parameters,
    candidateOperation.parameters,
    `${location}.parameters (candidate)`,
    issues,
  )

  for (const [key, baseParameter] of baseParameters) {
    const parameterLocation =
      `${location}.parameters[${JSON.stringify(baseParameter.name)}]`
    const candidateParameter = candidateParameters.get(key)
    if (!candidateParameter) {
      addIssue(
        issues,
        'parameter-contract',
        parameterLocation,
        'Existing operation parameter was removed.',
      )
      continue
    }
    if (
      (baseParameter.value.required ?? false) === false &&
      candidateParameter.value.required === true
    ) {
      addIssue(
        issues,
        'parameter-contract',
        `${parameterLocation}.required`,
        'Optional parameter became required.',
      )
    }
    for (const property of [
      'allowEmptyValue',
      'allowReserved',
      'explode',
      'style',
    ]) {
      compareExactSemanticValue(
        baseParameter.value[property],
        candidateParameter.value[property],
        `${parameterLocation}.${property}`,
        'parameter-contract',
        `Parameter serialization property ${property} changed.`,
        issues,
      )
    }
    compareSchema(
      baseDocument,
      candidateDocument,
      baseParameter.value.schema,
      candidateParameter.value.schema,
      'request',
      `${parameterLocation}.schema`,
      issues,
    )
    compareContent(
      baseDocument,
      candidateDocument,
      baseParameter.value.content,
      candidateParameter.value.content,
      'request',
      `${parameterLocation}.content`,
      true,
      issues,
    )
  }
  for (const [key, candidateParameter] of candidateParameters) {
    if (
      !baseParameters.has(key) &&
      candidateParameter.value.required === true
    ) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}.parameters[${JSON.stringify(candidateParameter.name)}]`,
        'Existing operation added a required parameter.',
      )
    }
  }
}

/**
 * Resolves and merges path and operation parameters using OpenAPI override semantics.
 *
 * @param document - Owning OpenAPI document.
 * @param pathParameters - Path-level parameter array.
 * @param operationParameters - Operation-level parameter array.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Parameter map keyed by normalized `(in,name)`.
 */
function collectParameters(
  document: JsonRecord,
  pathParameters: unknown,
  operationParameters: unknown,
  location: string,
  issues: IssueCollector,
): ReadonlyMap<string, ResolvedParameter> {
  const parameters = new Map<string, ResolvedParameter>()
  appendParameters(
    document,
    pathParameters,
    `${location}.path`,
    parameters,
    issues,
    false,
  )
  appendParameters(
    document,
    operationParameters,
    `${location}.operation`,
    parameters,
    issues,
    true,
  )
  return parameters
}

/**
 * Appends one parameter array and rejects duplicate identities in the same scope.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Optional parameter array.
 * @param location - Array diagnostic location.
 * @param target - Merged parameter target.
 * @param issues - Mutable issue collector.
 * @param allowOverride - Whether operation parameters may override path parameters.
 */
function appendParameters(
  document: JsonRecord,
  value: unknown,
  location: string,
  target: Map<string, ResolvedParameter>,
  issues: IssueCollector,
  allowOverride: boolean,
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      'parameter-contract',
      location,
      'Parameters must be an array.',
    )
    return
  }
  const localKeys = new Set<string>()
  for (const [index, parameterValue] of value.entries()) {
    const parameter = resolveObject(
      document,
      parameterValue,
      `${location}[${index}]`,
      issues,
    )
    if (!parameter) continue
    const name = parameter.name
    const inputLocation = parameter.in
    if (typeof name !== 'string' || typeof inputLocation !== 'string') {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}]`,
        'Parameter must have string name and in properties.',
      )
      continue
    }
    if (
      inputLocation !== 'cookie' &&
      inputLocation !== 'header' &&
      inputLocation !== 'path' &&
      inputLocation !== 'query'
    ) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}].in`,
        'Parameter in must be cookie, header, path, or query.',
      )
    }
    if (
      parameter.required !== undefined &&
      typeof parameter.required !== 'boolean'
    ) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}].required`,
        'Parameter required must be boolean when present.',
      )
    }
    if (inputLocation === 'path' && parameter.required !== true) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}].required`,
        'Path parameters must declare required: true.',
      )
    }
    const hasSchema = Object.hasOwn(parameter, 'schema')
    const hasContent = Object.hasOwn(parameter, 'content')
    if (hasSchema === hasContent) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}]`,
        'Parameter must define exactly one of schema or content.',
      )
    }
    if (hasContent) {
      const content = optionalRecord(
        parameter.content,
        `${location}[${index}].content`,
        issues,
      )
      if (content && Object.keys(content).length !== 1) {
        addIssue(
          issues,
          'parameter-contract',
          `${location}[${index}].content`,
          'Parameter content must define exactly one media type.',
        )
      }
    }
    const normalizedName = inputLocation === 'header'
      ? name.toLowerCase()
      : name
    const key = `${inputLocation}\u0000${normalizedName}`
    if (localKeys.has(key)) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}]`,
        'Duplicate parameter identity is not allowed.',
      )
      continue
    }
    localKeys.add(key)
    if (!allowOverride && target.has(key)) {
      addIssue(
        issues,
        'parameter-contract',
        `${location}[${index}]`,
        'Duplicate path-level parameter identity is not allowed.',
      )
      continue
    }
    target.set(key, {
      inputLocation,
      key,
      name,
      value: parameter,
    })
  }
}

/**
 * Compares the request-body presence, media types, and request schemas.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base request body.
 * @param candidateValue - Candidate request body.
 * @param location - Request body location.
 * @param issues - Mutable issue collector.
 */
function compareRequestBody(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  location: string,
  issues: IssueCollector,
): void {
  if (baseValue === undefined) {
    if (candidateValue === undefined) return
    const candidate = resolveObject(
      candidateDocument,
      candidateValue,
      `${location} (candidate)`,
      issues,
    )
    if (candidate?.required === true) {
      addIssue(
        issues,
        'request-contract',
        `${location}.required`,
        'Existing operation added a required request body.',
      )
    }
    return
  }
  const base = resolveObject(baseDocument, baseValue, `${location} (base)`, issues)
  const candidate = resolveObject(
    candidateDocument,
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (!base || !candidate) {
    addIssue(
      issues,
      'request-contract',
      location,
      'Existing request body was removed or became invalid.',
    )
    return
  }
  if ((base.required ?? false) === false && candidate.required === true) {
    addIssue(
      issues,
      'request-contract',
      `${location}.required`,
      'Optional request body became required.',
    )
  }
  compareContent(
    baseDocument,
    candidateDocument,
    base.content,
    candidate.content,
    'request',
    `${location}.content`,
    true,
    issues,
  )
}

/**
 * Compares exact response status/header/media sets and response schemas.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base responses object.
 * @param candidateValue - Candidate responses object.
 * @param location - Responses location.
 * @param issues - Mutable issue collector.
 */
function compareResponses(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const base = requireRecord(baseValue, `${location} (base)`, issues)
  const candidate = requireRecord(candidateValue, `${location} (candidate)`, issues)
  if (!base || !candidate) return
  compareExactKeySet(
    base,
    candidate,
    location,
    'response-contract',
    'Response status set changed.',
    issues,
  )
  for (const [status, baseResponseValue] of Object.entries(base)) {
    const responseLocation = `${location}[${JSON.stringify(status)}]`
    const baseResponse = resolveObject(
      baseDocument,
      baseResponseValue,
      `${responseLocation} (base)`,
      issues,
    )
    const candidateResponse = resolveObject(
      candidateDocument,
      candidate[status],
      `${responseLocation} (candidate)`,
      issues,
    )
    if (!baseResponse || !candidateResponse) continue
    if (candidateResponse.links !== undefined) {
      addIssue(
        issues,
        'response-contract',
        `${responseLocation}.links`,
        'Response links are not supported by the compatibility checker.',
      )
    }
    compareResponseHeaders(
      baseDocument,
      candidateDocument,
      baseResponse.headers,
      candidateResponse.headers,
      `${responseLocation}.headers`,
      issues,
    )
    compareContent(
      baseDocument,
      candidateDocument,
      baseResponse.content,
      candidateResponse.content,
      'response',
      `${responseLocation}.content`,
      true,
      issues,
    )
  }
}

/**
 * Compares exact response-header identities and their schemas.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base header map.
 * @param candidateValue - Candidate header map.
 * @param location - Header location.
 * @param issues - Mutable issue collector.
 */
function compareResponseHeaders(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  location: string,
  issues: IssueCollector,
): void {
  compareHeaderMap(
    baseDocument,
    candidateDocument,
    baseValue,
    candidateValue,
    'response',
    location,
    'Response header set changed.',
    issues,
    new WeakMap(),
  )
}

/**
 * Compares an exact, case-insensitive Header Object map.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base header map.
 * @param candidateValue - Candidate header map.
 * @param direction - Boundary direction for contained schemas.
 * @param location - Header-map location.
 * @param setChangedMessage - Finding emitted when header identities change.
 * @param issues - Mutable issue collector.
 * @param comparedHeaders - Header pairs already traversed recursively.
 */
function compareHeaderMap(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  setChangedMessage: string,
  issues: IssueCollector,
  comparedHeaders: ComparedHeaderPairs,
): void {
  const rule = direction === 'request'
    ? 'request-contract'
    : 'response-contract'
  const base = optionalRecord(baseValue, `${location} (base)`, issues)
  const candidate = optionalRecord(
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (!base && !candidate) return
  if (!base || !candidate) {
    addIssue(
      issues,
      rule,
      location,
      setChangedMessage,
    )
    return
  }
  const baseByName = normalizeHeaderMap(
    base,
    `${location} (base)`,
    rule,
    issues,
  )
  const candidateByName = normalizeHeaderMap(
    candidate,
    `${location} (candidate)`,
    rule,
    issues,
  )
  compareExactKeySet(
    baseByName,
    candidateByName,
    location,
    rule,
    setChangedMessage,
    issues,
  )
  for (const [name, baseHeaderValue] of Object.entries(baseByName)) {
    const headerLocation = `${location}[${JSON.stringify(name)}]`
    const baseHeader = resolveObject(
      baseDocument,
      baseHeaderValue,
      `${headerLocation} (base)`,
      issues,
    )
    const candidateHeader = resolveObject(
      candidateDocument,
      candidateByName[name],
      `${headerLocation} (candidate)`,
      issues,
    )
    if (!baseHeader || !candidateHeader) continue
    compareHeaderContract(
      baseDocument,
      candidateDocument,
      baseHeader,
      candidateHeader,
      direction,
      headerLocation,
      issues,
      comparedHeaders,
    )
  }
}

/**
 * Compares one Header Object, including schema- or content-based values.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseHeader - Resolved base Header Object.
 * @param candidateHeader - Resolved candidate Header Object.
 * @param direction - Boundary direction for contained schemas.
 * @param location - Header diagnostic location.
 * @param issues - Mutable issue collector.
 * @param comparedHeaders - Header pairs already traversed recursively.
 */
function compareHeaderContract(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseHeader: JsonRecord,
  candidateHeader: JsonRecord,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
  comparedHeaders: ComparedHeaderPairs,
): void {
  if (markObjectPairCompared(baseHeader, candidateHeader, comparedHeaders)) {
    return
  }
  const rule = direction === 'request'
    ? 'request-contract'
    : 'response-contract'
  compareExactSemanticValue(
    omitObjectKey(omitObjectKey(baseHeader, 'schema'), 'content'),
    omitObjectKey(omitObjectKey(candidateHeader, 'schema'), 'content'),
    location,
    rule,
    `${direction === 'request' ? 'Request' : 'Response'} header contract changed.`,
    issues,
  )
  compareSchema(
    baseDocument,
    candidateDocument,
    baseHeader.schema,
    candidateHeader.schema,
    direction,
    `${location}.schema`,
    issues,
  )
  compareContent(
    baseDocument,
    candidateDocument,
    baseHeader.content,
    candidateHeader.content,
    direction,
    `${location}.content`,
    true,
    issues,
    comparedHeaders,
  )
}

/**
 * Normalizes response header names and rejects case-insensitive duplicates.
 *
 * @param headers - Response header map.
 * @param location - Header map location.
 * @param rule - Finding category for this header boundary.
 * @param issues - Mutable issue collector.
 * @returns Header map keyed by lowercase name.
 */
function normalizeHeaderMap(
  headers: JsonRecord,
  location: string,
  rule: PublicApiCompatibilityRule,
  issues: IssueCollector,
): JsonRecord {
  const normalized: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (Object.hasOwn(normalized, key)) {
      addIssue(
        issues,
        rule,
        `${location}[${JSON.stringify(name)}]`,
        'Duplicate case-insensitive header is not allowed.',
      )
      continue
    }
    defineRecordProperty(normalized, key, value)
  }
  return normalized
}

/**
 * Compares an exact media-type set and the schema for each media type.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base content map.
 * @param candidateValue - Candidate content map.
 * @param direction - Request or response schema direction.
 * @param location - Content location.
 * @param exactSet - Whether media-type additions must also fail closed.
 * @param issues - Mutable issue collector.
 * @param comparedHeaders - Header pairs already traversed recursively.
 */
function compareContent(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  exactSet: boolean,
  issues: IssueCollector,
  comparedHeaders: ComparedHeaderPairs = new WeakMap(),
): void {
  const base = optionalRecord(baseValue, `${location} (base)`, issues)
  const candidate = optionalRecord(
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (!base && !candidate) return
  if (!base || !candidate) {
    addIssue(
      issues,
      direction === 'request' ? 'request-contract' : 'response-contract',
      location,
      'Content media-type set changed.',
    )
    return
  }
  if (exactSet) {
    compareExactKeySet(
      base,
      candidate,
      location,
      direction === 'request' ? 'request-contract' : 'response-contract',
      'Content media-type set changed.',
      issues,
    )
  } else {
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(candidate, key)) {
        addIssue(
          issues,
          direction === 'request' ? 'request-contract' : 'response-contract',
          `${location}[${JSON.stringify(key)}]`,
          'Existing content media type was removed.',
        )
      }
    }
  }
  for (const [mediaType, baseMediaValue] of Object.entries(base)) {
    const mediaLocation = `${location}[${JSON.stringify(mediaType)}]`
    const baseMedia = requireRecord(
      baseMediaValue,
      `${mediaLocation} (base)`,
      issues,
    )
    const candidateMedia = requireRecord(
      candidate[mediaType],
      `${mediaLocation} (candidate)`,
      issues,
    )
    if (!baseMedia || !candidateMedia) continue
    compareExactSemanticValue(
      omitObjectKey(omitObjectKey(baseMedia, 'schema'), 'encoding'),
      omitObjectKey(omitObjectKey(candidateMedia, 'schema'), 'encoding'),
      mediaLocation,
      direction === 'request' ? 'request-contract' : 'response-contract',
      'Media-type encoding contract changed.',
      issues,
    )
    compareEncoding(
      baseDocument,
      candidateDocument,
      baseMedia.encoding,
      candidateMedia.encoding,
      direction,
      `${mediaLocation}.encoding`,
      issues,
      comparedHeaders,
    )
    compareSchema(
      baseDocument,
      candidateDocument,
      baseMedia.schema,
      candidateMedia.schema,
      direction,
      `${mediaLocation}.schema`,
      issues,
    )
  }
}

/**
 * Compares Media Type encoding entries and their direction-sensitive headers.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base Encoding Object map.
 * @param candidateValue - Candidate Encoding Object map.
 * @param direction - Boundary direction for encoding-header schemas.
 * @param location - Encoding-map diagnostic location.
 * @param issues - Mutable issue collector.
 * @param comparedHeaders - Header pairs already traversed recursively.
 */
function compareEncoding(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
  comparedHeaders: ComparedHeaderPairs,
): void {
  const rule = direction === 'request'
    ? 'request-contract'
    : 'response-contract'
  const base = optionalRecord(baseValue, `${location} (base)`, issues)
  const candidate = optionalRecord(
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (!base && !candidate) return
  if (!base || !candidate) {
    addIssue(
      issues,
      rule,
      location,
      'Media-type encoding contract changed.',
    )
    return
  }
  compareExactKeySet(
    base,
    candidate,
    location,
    rule,
    'Media-type encoding contract changed.',
    issues,
  )
  for (const [property, baseEncodingValue] of Object.entries(base)) {
    const encodingLocation = `${location}[${JSON.stringify(property)}]`
    const baseEncoding = requireRecord(
      baseEncodingValue,
      `${encodingLocation} (base)`,
      issues,
    )
    const candidateEncoding = requireRecord(
      candidate[property],
      `${encodingLocation} (candidate)`,
      issues,
    )
    if (!baseEncoding || !candidateEncoding) continue
    compareExactSemanticValue(
      omitObjectKey(baseEncoding, 'headers'),
      omitObjectKey(candidateEncoding, 'headers'),
      encodingLocation,
      rule,
      'Encoding property contract changed.',
      issues,
    )
    compareHeaderMap(
      baseDocument,
      candidateDocument,
      baseEncoding.headers,
      candidateEncoding.headers,
      direction,
      `${encodingLocation}.headers`,
      'Encoding header set changed.',
      issues,
      comparedHeaders,
    )
  }
}

/**
 * Compares one JSON Schema in request-acceptance or response-production direction.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base schema.
 * @param candidateValue - Candidate schema.
 * @param direction - Boundary direction controlling variance.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 * @param comparedPairs - Schema pairs already traversed by this root comparison.
 */
function compareSchema(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
  comparedPairs: ComparedSchemaPairs = new WeakMap(),
): void {
  if (baseValue === undefined && candidateValue === undefined) return
  if (typeof baseValue === 'boolean' || typeof candidateValue === 'boolean') {
    if (baseValue !== candidateValue) {
      addIssue(
        issues,
        'schema-contract',
        location,
        'Boolean schema contract changed and compatibility cannot be proven.',
      )
    }
    return
  }
  const base = resolveObject(baseDocument, baseValue, `${location} (base)`, issues)
  const candidate = resolveObject(
    candidateDocument,
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (!base || !candidate) {
    addIssue(
      issues,
      'schema-contract',
      location,
      'Schema was removed or became invalid.',
    )
    return
  }
  if (markObjectPairCompared(base, candidate, comparedPairs)) return
  validateSchemaKeys(base, `${location} (base)`, issues)
  validateSchemaKeys(candidate, `${location} (candidate)`, issues)
  validateSchemaKeywordShapes(base, `${location} (base)`, issues)
  validateSchemaKeywordShapes(candidate, `${location} (candidate)`, issues)
  validateSchemaReferences(baseDocument, base, `${location} (base)`, issues)
  validateSchemaReferences(
    candidateDocument,
    candidate,
    `${location} (candidate)`,
    issues,
  )

  compareTypeContract(base.type, candidate.type, direction, `${location}.type`, issues)
  compareEnumContract(base.enum, candidate.enum, direction, `${location}.enum`, issues)
  compareConstContract(base.const, candidate.const, direction, `${location}.const`, issues)
  compareRequiredContract(
    base.required,
    candidate.required,
    direction,
    `${location}.required`,
    issues,
  )
  compareSchemaProperties(
    baseDocument,
    candidateDocument,
    base,
    candidate,
    direction,
    location,
    issues,
    comparedPairs,
  )
  compareAdditionalProperties(
    baseDocument,
    candidateDocument,
    base.additionalProperties,
    candidate.additionalProperties,
    direction,
    `${location}.additionalProperties`,
    issues,
    comparedPairs,
  )
  compareSchema(
    baseDocument,
    candidateDocument,
    base.items,
    candidate.items,
    direction,
    `${location}.items`,
    issues,
    comparedPairs,
  )
  compareDirectionalConstraints(base, candidate, direction, location, issues)
  compareComposition(
    baseDocument,
    candidateDocument,
    base,
    candidate,
    location,
    issues,
  )
  compareUnknownSchemaKeys(base, candidate, location, issues)
}

/**
 * Marks a resolved object pair and reports whether it was already traversed.
 *
 * Recursive `$ref` graphs remain validated separately and therefore fail closed,
 * while this identity guard prevents the directional comparator from overflowing.
 *
 * @param base - Resolved base object.
 * @param candidate - Resolved candidate object.
 * @param comparedPairs - Object pairs visited by the root comparison.
 * @returns Whether the same object pair was already compared.
 */
function markObjectPairCompared(
  base: JsonRecord,
  candidate: JsonRecord,
  comparedPairs: ComparedObjectPairs,
): boolean {
  const candidateSchemas = comparedPairs.get(base)
  if (candidateSchemas?.has(candidate)) return true
  if (candidateSchemas) {
    candidateSchemas.add(candidate)
  } else {
    comparedPairs.set(base, new WeakSet([candidate]))
  }
  return false
}

/**
 * Validates that every schema keyword is explicitly understood or annotation-only.
 *
 * @param schema - Resolved schema.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 */
function validateSchemaKeys(
  schema: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${key}`,
        `Unsupported JSON Schema keyword ${JSON.stringify(key)} cannot be proven compatible.`,
      )
    }
  }
}

/**
 * Validates primitive and container shapes for supported schema keywords.
 *
 * @param schema - Resolved schema object.
 * @param location - Schema diagnostic location.
 * @param issues - Mutable compatibility issue collector.
 */
function validateSchemaKeywordShapes(
  schema: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const typeValues = typeof schema.type === 'string'
    ? [schema.type]
    : schema.type
  if (
    typeValues !== undefined &&
    (
      !Array.isArray(typeValues) ||
      typeValues.some((value) => typeof value !== 'string')
    )
  ) {
    addIssue(
      issues,
      'schema-contract',
      `${location}.type`,
      'Schema type must be a string or an array of strings.',
    )
  } else if (Array.isArray(typeValues)) {
    if (typeValues.length === 0) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.type`,
        'Schema type arrays must not be empty.',
      )
    }
    if (new Set(typeValues).size !== typeValues.length) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.type`,
        'Schema type arrays must contain unique values.',
      )
    }
    for (const typeName of typeValues) {
      if (!SCHEMA_TYPE_NAMES.has(typeName)) {
        addIssue(
          issues,
          'schema-contract',
          `${location}.type`,
          `Unsupported schema type ${JSON.stringify(typeName)}.`,
        )
      }
    }
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    addIssue(
      issues,
      'schema-contract',
      `${location}.enum`,
      'Schema enum must be an array.',
    )
  } else if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.enum`,
        'Schema enum arrays must not be empty.',
      )
    }
    try {
      const values = schema.enum.map((value) => serializeCanonicalJson(value))
      if (new Set(values).size !== values.length) {
        addIssue(
          issues,
          'schema-contract',
          `${location}.enum`,
          'Schema enum arrays must contain unique values.',
        )
      }
    } catch {
      addIssue(
        issues,
        'schema-contract',
        `${location}.enum`,
        'Schema enum values must be bounded JSON values.',
      )
    }
  }
  if (
    schema.properties !== undefined &&
    !isJsonRecord(schema.properties)
  ) {
    addIssue(
      issues,
      'schema-contract',
      `${location}.properties`,
      'Schema properties must be an object when present.',
    )
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((value) => typeof value !== 'string')
    ) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.required`,
        'Schema required must be an array of strings.',
      )
    } else if (new Set(schema.required).size !== schema.required.length) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.required`,
        'Schema required arrays must contain unique values.',
      )
    }
  }
  for (
    const property of [
      'deprecated',
      'nullable',
      'readOnly',
      'uniqueItems',
      'writeOnly',
    ]
  ) {
    validateOptionalBooleanProperty(
      schema,
      property,
      location,
      'schema-contract',
      issues,
    )
  }
  for (const property of ['format', 'pattern']) {
    validateOptionalStringProperty(
      schema,
      property,
      location,
      'schema-contract',
      issues,
    )
  }
  if (schema.multipleOf !== undefined) {
    if (
      typeof schema.multipleOf !== 'number' ||
      schema.multipleOf <= 0
    ) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.multipleOf`,
        'Schema multipleOf must be a positive number when present.',
      )
    }
  }
  for (
    const property of [
      'exclusiveMaximum',
      'exclusiveMinimum',
      'maximum',
      'minimum',
    ]
  ) {
    const value = schema[property]
    if (value !== undefined && typeof value !== 'number') {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${property}`,
        `Schema ${property} must be numeric when present.`,
      )
    }
  }
  for (
    const property of [
      'maxItems',
      'maxLength',
      'maxProperties',
      'minItems',
      'minLength',
      'minProperties',
    ]
  ) {
    const value = schema[property]
    if (
      value !== undefined &&
      (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0
      )
    ) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${property}`,
        `Schema ${property} must be a nonnegative integer when present.`,
      )
    }
  }
  for (const property of ['allOf', 'anyOf', 'oneOf']) {
    const value = schema[property]
    if (value !== undefined && !Array.isArray(value)) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${property}`,
        `Schema ${property} must be an array when present.`,
      )
    } else if (Array.isArray(value) && value.length === 0) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${property}`,
        `Schema ${property} must not be empty.`,
      )
    }
  }
  for (
    const property of [
      'additionalProperties',
      'else',
      'if',
      'items',
      'not',
      'then',
      'unevaluatedProperties',
    ]
  ) {
    const value = schema[property]
    if (
      value !== undefined &&
      typeof value !== 'boolean' &&
      !isJsonRecord(value)
    ) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${property}`,
        `Schema ${property} must be a boolean or object when present.`,
      )
    }
  }
  if (schema.discriminator !== undefined) {
    const discriminator = requireRecord(
      schema.discriminator,
      `${location}.discriminator`,
      issues,
    )
    if (discriminator) {
      validateRequiredStringProperty(
        discriminator,
        'propertyName',
        `${location}.discriminator`,
        'schema-contract',
        issues,
      )
      const mapping = optionalRecord(
        discriminator.mapping,
        `${location}.discriminator.mapping`,
        issues,
      )
      if (mapping) {
        for (const [name, target] of Object.entries(mapping)) {
          if (typeof target !== 'string') {
            addIssue(
              issues,
              'schema-contract',
              `${location}.discriminator.mapping[${JSON.stringify(name)}]`,
              'Discriminator mapping targets must be strings.',
            )
          }
        }
      }
    }
  }
}

/**
 * Compares type sets using contravariant requests and covariant responses.
 *
 * @param baseValue - Base type string or string array.
 * @param candidateValue - Candidate type string or string array.
 * @param direction - Schema boundary direction.
 * @param location - Type location.
 * @param issues - Mutable issue collector.
 */
function compareTypeContract(
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
): void {
  const base = normalizeStringSet(baseValue, `${location} (base)`, issues)
  const candidate = normalizeStringSet(
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (baseValue !== undefined && !base) return
  if (candidateValue !== undefined && !candidate) return
  if (direction === 'request') {
    if (base === undefined) {
      if (candidate !== undefined) {
        addIssue(issues, 'schema-contract', location, 'Request type was narrowed.')
      }
      return
    }
    if (candidate === undefined) return
    if (!isSubset(base, candidate)) {
      addIssue(issues, 'schema-contract', location, 'Request type was narrowed.')
    }
    return
  }
  if (candidate === undefined) {
    if (base !== undefined) {
      addIssue(issues, 'schema-contract', location, 'Response type was widened.')
    }
    return
  }
  if (base !== undefined && !isSubset(candidate, base)) {
    addIssue(issues, 'schema-contract', location, 'Response type was widened.')
  }
}

/**
 * Compares enum values using request acceptance and response production variance.
 *
 * @param baseValue - Base enum array.
 * @param candidateValue - Candidate enum array.
 * @param direction - Schema boundary direction.
 * @param location - Enum location.
 * @param issues - Mutable issue collector.
 */
function compareEnumContract(
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
): void {
  const base = normalizeValueSet(baseValue, `${location} (base)`, issues)
  const candidate = normalizeValueSet(
    candidateValue,
    `${location} (candidate)`,
    issues,
  )
  if (baseValue !== undefined && !base) return
  if (candidateValue !== undefined && !candidate) return
  if (direction === 'request') {
    if (base === undefined && candidate !== undefined) {
      addIssue(issues, 'schema-contract', location, 'Request enum was narrowed.')
    } else if (base && candidate && !isSubset(base, candidate)) {
      addIssue(issues, 'schema-contract', location, 'Request enum was narrowed.')
    }
    return
  }
  if (candidate === undefined && base !== undefined) {
    addIssue(issues, 'schema-contract', location, 'Response enum was widened.')
  } else if (base && candidate && !isSubset(candidate, base)) {
    addIssue(issues, 'schema-contract', location, 'Response enum was widened.')
  }
}

/**
 * Compares const constraints as one-value enums.
 *
 * @param baseValue - Base const value.
 * @param candidateValue - Candidate const value.
 * @param direction - Schema boundary direction.
 * @param location - Const location.
 * @param issues - Mutable issue collector.
 */
function compareConstContract(
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
): void {
  if (baseValue === undefined && candidateValue === undefined) return
  if (direction === 'request' && baseValue !== undefined && candidateValue === undefined) {
    return
  }
  if (
    direction === 'response' &&
    baseValue === undefined &&
    candidateValue !== undefined
  ) {
    return
  }
  if (!semanticValuesEqual(baseValue, candidateValue)) {
    addIssue(
      issues,
      'schema-contract',
      location,
      `${direction === 'request' ? 'Request' : 'Response'} const contract changed.`,
    )
  }
}

/**
 * Compares required properties with direction-aware variance.
 *
 * @param baseValue - Base required array.
 * @param candidateValue - Candidate required array.
 * @param direction - Schema boundary direction.
 * @param location - Required location.
 * @param issues - Mutable issue collector.
 */
function compareRequiredContract(
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
): void {
  const base = normalizeStringSet(baseValue, `${location} (base)`, issues) ??
    new Set<string>()
  const candidate = normalizeStringSet(
    candidateValue,
    `${location} (candidate)`,
    issues,
  ) ?? new Set<string>()
  const compatible = direction === 'request'
    ? isSubset(candidate, base)
    : isSubset(base, candidate)
  if (!compatible) {
    addIssue(
      issues,
      'schema-contract',
      location,
      direction === 'request'
        ? 'Request added a required property.'
        : 'Response removed or optionalized a required property.',
    )
  }
}

/**
 * Compares named schema properties and recursively preserves existing fields.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseSchema - Base schema object.
 * @param candidateSchema - Candidate schema object.
 * @param direction - Schema boundary direction.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 * @param comparedPairs - Schema pairs already traversed by this root comparison.
 */
function compareSchemaProperties(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseSchema: JsonRecord,
  candidateSchema: JsonRecord,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
  comparedPairs: ComparedSchemaPairs,
): void {
  const base = optionalRecord(
    baseSchema.properties,
    `${location}.properties (base)`,
    issues,
  )
  const candidate = optionalRecord(
    candidateSchema.properties,
    `${location}.properties (candidate)`,
    issues,
  )
  if (!base && !candidate) return
  if (base && !candidate) {
    addIssue(
      issues,
      'schema-contract',
      `${location}.properties`,
      'Named schema properties were removed.',
    )
    return
  }
  if (!candidate) return
  const baseProperties: JsonRecord = base ?? {}
  for (const [property, baseProperty] of Object.entries(baseProperties)) {
    const propertyLocation = `${location}.properties[${JSON.stringify(property)}]`
    if (!Object.hasOwn(candidate, property)) {
      addIssue(
        issues,
        'schema-contract',
        propertyLocation,
        'Existing schema property was removed.',
      )
      continue
    }
    compareSchema(
      baseDocument,
      candidateDocument,
      baseProperty,
      candidate[property],
      direction,
      propertyLocation,
      issues,
      comparedPairs,
    )
  }
  for (const [property, candidateProperty] of Object.entries(candidate)) {
    if (Object.hasOwn(baseProperties, property)) continue
    const propertyLocation = `${location}.properties[${JSON.stringify(property)}]`
    const baseAdditionalProperties = baseSchema.additionalProperties ?? true
    if (direction === 'request') {
      if (baseAdditionalProperties === false) continue
      compareSchema(
        baseDocument,
        candidateDocument,
        baseAdditionalProperties,
        candidateProperty,
        direction,
        propertyLocation,
        issues,
        comparedPairs,
      )
      continue
    }
    if (baseAdditionalProperties === true) continue
    if (baseAdditionalProperties === false) {
        addIssue(
          issues,
          'schema-contract',
          propertyLocation,
          'Response added a property to a closed object schema.',
        )
      continue
    }
    compareSchema(
      baseDocument,
      candidateDocument,
      baseAdditionalProperties,
      candidateProperty,
      direction,
      propertyLocation,
      issues,
      comparedPairs,
    )
  }
}

/**
 * Compares the default-true additionalProperties contract.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param baseValue - Base additionalProperties value.
 * @param candidateValue - Candidate additionalProperties value.
 * @param direction - Schema boundary direction.
 * @param location - Additional-properties location.
 * @param issues - Mutable issue collector.
 * @param comparedPairs - Schema pairs already traversed by this root comparison.
 */
function compareAdditionalProperties(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
  comparedPairs: ComparedSchemaPairs,
): void {
  const base = baseValue ?? true
  const candidate = candidateValue ?? true
  if (typeof base === 'boolean' && typeof candidate === 'boolean') {
    const incompatible = direction === 'request'
      ? base && !candidate
      : !base && candidate
    if (incompatible) {
      addIssue(
        issues,
        'schema-contract',
        location,
        direction === 'request'
          ? 'Request additional properties were no longer accepted.'
          : 'Response additional properties were newly allowed.',
      )
    }
    return
  }
  if (direction === 'request') {
    if (base === true && candidate !== true) {
      addIssue(
        issues,
        'schema-contract',
        location,
        'Request additional properties were narrowed.',
      )
      return
    }
    if (candidate === true) return
  } else {
    if (candidate === true && base !== true) {
      addIssue(
        issues,
        'schema-contract',
        location,
        'Response additional properties were widened.',
      )
      return
    }
    if (base === true) return
  }
  compareSchema(
    baseDocument,
    candidateDocument,
    base,
    candidate,
    direction,
    location,
    issues,
    comparedPairs,
  )
}

/**
 * Compares numeric and cardinality constraints in the safe variance direction.
 *
 * @param base - Base schema.
 * @param candidate - Candidate schema.
 * @param direction - Schema boundary direction.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 */
function compareDirectionalConstraints(
  base: JsonRecord,
  candidate: JsonRecord,
  direction: SchemaDirection,
  location: string,
  issues: IssueCollector,
): void {
  for (const key of MINIMUM_SCHEMA_KEYS) {
    compareDirectionalNumber(
      base[key],
      candidate[key],
      direction,
      'minimum',
      `${location}.${key}`,
      issues,
    )
  }
  for (const key of MAXIMUM_SCHEMA_KEYS) {
    compareDirectionalNumber(
      base[key],
      candidate[key],
      direction,
      'maximum',
      `${location}.${key}`,
      issues,
    )
  }
  for (const key of EXACT_SCHEMA_KEYS) {
    compareExactSemanticValue(
      base[key],
      candidate[key],
      `${location}.${key}`,
      'schema-contract',
      `Schema keyword ${key} changed.`,
      issues,
      key === 'default',
    )
  }
}

/**
 * Compares one directional numeric bound.
 *
 * @param baseValue - Base numeric bound.
 * @param candidateValue - Candidate numeric bound.
 * @param direction - Schema boundary direction.
 * @param bound - Whether the value is a lower or upper bound.
 * @param location - Bound location.
 * @param issues - Mutable issue collector.
 */
function compareDirectionalNumber(
  baseValue: unknown,
  candidateValue: unknown,
  direction: SchemaDirection,
  bound: 'maximum' | 'minimum',
  location: string,
  issues: IssueCollector,
): void {
  if (baseValue !== undefined && typeof baseValue !== 'number') {
    addIssue(
      issues,
      'schema-contract',
      `${location} (base)`,
      'Schema bound must be numeric.',
    )
    return
  }
  if (candidateValue !== undefined && typeof candidateValue !== 'number') {
    addIssue(
      issues,
      'schema-contract',
      `${location} (candidate)`,
      'Schema bound must be numeric.',
    )
    return
  }
  const requestNarrowed = direction === 'request' && (
    baseValue === undefined
      ? candidateValue !== undefined
      : candidateValue !== undefined && (
        bound === 'minimum'
          ? candidateValue > baseValue
          : candidateValue < baseValue
      )
  )
  const responseWidened = direction === 'response' && (
    candidateValue === undefined
      ? baseValue !== undefined
      : baseValue !== undefined && (
        bound === 'minimum'
          ? candidateValue < baseValue
          : candidateValue > baseValue
      )
  )
  if (requestNarrowed || responseWidened) {
    addIssue(
      issues,
      'schema-contract',
      location,
      direction === 'request'
        ? 'Request constraint was narrowed.'
        : 'Response constraint was widened.',
    )
  }
}

/**
 * Fails closed for any changed composition or conditional-schema construct.
 *
 * @param baseDocument - Trusted base document.
 * @param candidateDocument - Candidate document.
 * @param base - Base schema.
 * @param candidate - Candidate schema.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 */
function compareComposition(
  baseDocument: JsonRecord,
  candidateDocument: JsonRecord,
  base: JsonRecord,
  candidate: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  for (const key of COMPOSITION_KEYS) {
    const expansionContext = getCompositionExpansionContext(key)
    const baseExpanded = expandLocalReferences(
      baseDocument,
      base[key],
      `${location}.${key} (base)`,
      issues,
      expansionContext,
    )
    const candidateExpanded = expandLocalReferences(
      candidateDocument,
      candidate[key],
      `${location}.${key} (candidate)`,
      issues,
      expansionContext,
    )
    if (!semanticValuesEqual(baseExpanded, candidateExpanded)) {
      addIssue(
        issues,
        'schema-contract',
        `${location}.${key}`,
        `Schema composition keyword ${key} changed; compatibility cannot be proven.`,
      )
    }
  }
}

/**
 * Selects how one composition keyword contains nested schema values.
 *
 * @param key - Supported composition or discriminator keyword.
 * @returns Expansion context for the keyword value.
 */
function getCompositionExpansionContext(key: string): SchemaExpansionContext {
  if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
    return 'schema-array'
  }
  return key === 'discriminator' ? 'semantic' : 'schema'
}

/**
 * Fails closed if any unsupported schema keyword differs.
 *
 * @param base - Base schema.
 * @param candidate - Candidate schema.
 * @param location - Schema location.
 * @param issues - Mutable issue collector.
 */
function compareUnknownSchemaKeys(
  base: JsonRecord,
  candidate: JsonRecord,
  location: string,
  issues: IssueCollector,
): void {
  const unknownKeys = new Set([
    ...Object.keys(base).filter((key) => !SCHEMA_KEYS.has(key)),
    ...Object.keys(candidate).filter((key) => !SCHEMA_KEYS.has(key)),
  ])
  for (const key of unknownKeys) {
    compareExactSemanticValue(
      base[key],
      candidate[key],
      `${location}.${key}`,
      'schema-contract',
      `Unsupported JSON Schema keyword ${key} changed.`,
      issues,
    )
  }
}

/**
 * Validates every nested local reference with memoization and bounded traversal.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Schema fragment to inspect.
 * @param location - Fragment location.
 * @param issues - Mutable issue collector.
 */
function validateSchemaReferences(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): void {
  const traversalContext = getSchemaTraversalContext(issues)
  let state = traversalContext.validationStates.get(document)
  if (!state) {
    state = {
      activeReferences: new Set(),
      budget: {
        exceeded: false,
        visitedNodes: 0,
      },
      completedReferences: new Set(),
      invalidReferences: new Set(),
      referenceDepths: new Map(),
      validatedRoots: new WeakSet(),
    }
    traversalContext.validationStates.set(document, state)
  }
  if (isJsonRecord(value) && state.validatedRoots.has(value)) return
  validateSchemaReferenceValue(
    document,
    value,
    location,
    issues,
    state,
    0,
  )
  if (isJsonRecord(value)) state.validatedRoots.add(value)
}

/**
 * Traverses one schema fragment while sharing validation state across a `$ref` DAG.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Schema fragment to inspect.
 * @param location - Fragment location.
 * @param issues - Mutable issue collector.
 * @param state - Shared memoization and traversal state.
 * @param depth - Current structural traversal depth.
 * @returns Maximum structural depth below this fragment.
 */
function validateSchemaReferenceValue(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
  state: SchemaReferenceValidationState,
  depth: number,
): number {
  if (!consumeSchemaTraversalBudget(state.budget, depth, location, issues)) {
    return 0
  }
  if (typeof value === 'boolean') return 0
  if (!isJsonRecord(value)) {
    addIssue(
      issues,
      'schema-contract',
      location,
      'JSON Schema values must be booleans or objects.',
    )
    return 0
  }
  validateSchemaKeys(value, location, issues)
  const reference = value.$ref
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !reference.startsWith('#/')) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Only resolvable local JSON Pointer references are supported.',
      )
      if (typeof reference === 'string') {
        state.invalidReferences.add(reference)
      }
      return 0
    }
    const semanticSiblings = Object.keys(value).filter(
      (key) => key !== '$ref' && !ANNOTATION_KEYS.has(key),
    )
    if (semanticSiblings.length > 0) {
      addIssue(
        issues,
        'reference-contract',
        location,
        '$ref siblings contain active constraints and cannot be proven compatible.',
      )
      state.invalidReferences.add(reference)
      return 0
    }
    if (state.activeReferences.has(reference)) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Cyclic local reference cannot be proven compatible.',
      )
      state.invalidReferences.add(reference)
      return 0
    }
    if (state.invalidReferences.has(reference)) return 0
    if (state.completedReferences.has(reference)) {
      const referenceDepth = state.referenceDepths.get(reference) ?? 0
      if (
        depth + referenceDepth > MAX_SCHEMA_REFERENCE_DEPTH &&
        !state.budget.exceeded
      ) {
        state.budget.exceeded = true
        addIssue(
          issues,
          'reference-contract',
          `${location}.$ref`,
          'Schema reference traversal exceeded the supported depth or node budget.',
        )
      }
      return referenceDepth
    }
    const resolved = resolveJsonPointer(document, reference)
    if (resolved === undefined) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Local reference could not be resolved.',
      )
      state.invalidReferences.add(reference)
      return 0
    }
    if (typeof resolved !== 'boolean' && !isJsonRecord(resolved)) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Local schema reference must resolve to a boolean or object schema.',
      )
      state.invalidReferences.add(reference)
      return 0
    }
    const issueCount = issues.length
    state.activeReferences.add(reference)
    let targetDepth = 0
    try {
      targetDepth = validateSchemaReferenceValue(
        document,
        resolved,
        `${location}->$ref(${reference})`,
        issues,
        state,
        depth + 1,
      )
    } finally {
      state.activeReferences.delete(reference)
    }
    if (issues.length === issueCount && !state.budget.exceeded) {
      state.completedReferences.add(reference)
      state.referenceDepths.set(reference, targetDepth + 1)
    } else {
      state.invalidReferences.add(reference)
    }
    return targetDepth + 1
  }
  validateSchemaKeywordShapes(value, location, issues)
  let maximumChildDepth = 0
  if (isJsonRecord(value.properties)) {
    for (const [property, propertySchema] of Object.entries(value.properties)) {
      const childDepth = validateSchemaReferenceValue(
        document,
        propertySchema,
        `${location}.properties[${JSON.stringify(property)}]`,
        issues,
        state,
        depth + 1,
      )
      maximumChildDepth = Math.max(maximumChildDepth, childDepth + 1)
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const schemas = value[key]
    if (!Array.isArray(schemas)) continue
    for (const [index, schema] of schemas.entries()) {
      const childDepth = validateSchemaReferenceValue(
        document,
        schema,
        `${location}.${key}[${index}]`,
        issues,
        state,
        depth + 1,
      )
      maximumChildDepth = Math.max(maximumChildDepth, childDepth + 1)
    }
  }
  for (
    const key of [
      'additionalProperties',
      'else',
      'if',
      'items',
      'not',
      'then',
      'unevaluatedProperties',
    ]
  ) {
    const schema = value[key]
    if (schema === undefined) continue
    const childDepth = validateSchemaReferenceValue(
      document,
      schema,
      `${location}.${key}`,
      issues,
      state,
      depth + 1,
    )
    maximumChildDepth = Math.max(maximumChildDepth, childDepth + 1)
  }
  return maximumChildDepth
}

/**
 * Expands local references into a compact, memoized semantic value.
 *
 * Every inline or referenced schema becomes a fixed-size digest of its
 * annotation-free body. This retains reference-transparent semantics without
 * materializing an exponentially large tree for a branching `$ref` DAG.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Value containing local references.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @param context - Semantic role of the root composition value.
 * @returns Compact semantic value, or undefined for an omitted value.
 */
function expandLocalReferences(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
  context: SchemaExpansionContext,
): unknown {
  if (value === undefined) return undefined
  const traversalContext = getSchemaTraversalContext(issues)
  let expansionBudget = traversalContext.expansionBudgets.get(document)
  if (!expansionBudget) {
    expansionBudget = {
      exceeded: false,
      visitedNodes: 0,
    }
    traversalContext.expansionBudgets.set(document, expansionBudget)
  }
  const state: SchemaReferenceExpansionState = {
    activeReferences: new Set(),
    budget: expansionBudget,
    expandedReferences: new Map(),
  }
  return expandLocalReferenceValue(
    document,
    value,
    location,
    issues,
    state,
    0,
    context,
  )
}

/**
 * Expands one fragment while sharing memoized definitions across a `$ref` DAG.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Fragment to expand.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @param state - Shared expansion and traversal state.
 * @param depth - Current structural traversal depth.
 * @param context - Semantic role of the current value.
 * @returns Compact expanded fragment, or undefined after a validation failure.
 */
function expandLocalReferenceValue(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
  state: SchemaReferenceExpansionState,
  depth: number,
  context: SchemaExpansionContext,
): unknown {
  if (!consumeSchemaTraversalBudget(state.budget, depth, location, issues)) {
    return undefined
  }
  if (Array.isArray(value)) {
    const childContext = context === 'schema-array'
      ? 'schema'
      : context === 'literal'
        ? 'literal'
        : 'semantic'
    const expanded = value.map((entry, index) =>
      expandLocalReferenceValue(
        document,
        entry,
        `${location}[${index}]`,
        issues,
        state,
        depth + 1,
        childContext,
      ))
    return context === 'schema-array'
      ? sortSemanticSchemaValues(expanded)
      : expanded
  }
  if (!isJsonRecord(value)) return value
  if (context === 'schema-map') {
    const expandedMap: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      defineRecordProperty(
        expandedMap,
        key,
        expandLocalReferenceValue(
          document,
          value[key],
          `${location}[${JSON.stringify(key)}]`,
          issues,
          state,
          depth + 1,
          'schema',
        ),
      )
    }
    return expandedMap
  }
  const reference = context === 'schema' ? value.$ref : undefined
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !reference.startsWith('#/')) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Only resolvable local JSON Pointer references are supported.',
      )
      return undefined
    }
    const semanticSiblings = Object.keys(value).filter(
      (key) => key !== '$ref' && !ANNOTATION_KEYS.has(key),
    )
    if (semanticSiblings.length > 0) {
      addIssue(
        issues,
        'reference-contract',
        location,
        '$ref siblings contain active constraints and cannot be expanded safely.',
      )
      return undefined
    }
    if (state.activeReferences.has(reference)) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Cyclic local reference cannot be expanded.',
      )
      return undefined
    }
    if (state.expandedReferences.has(reference)) {
      return state.expandedReferences.get(reference)
    }
    const resolved = resolveJsonPointer(document, reference)
    if (resolved === undefined) {
      addIssue(
        issues,
        'reference-contract',
        `${location}.$ref`,
        'Local reference could not be resolved.',
      )
      return undefined
    }
    state.activeReferences.add(reference)
    let expandedTarget: unknown
    try {
      expandedTarget = expandLocalReferenceValue(
        document,
        resolved,
        `${location}->$ref(${reference})`,
        issues,
        state,
        depth + 1,
        'schema',
      )
    } finally {
      state.activeReferences.delete(reference)
    }
    state.expandedReferences.set(reference, expandedTarget)
    return expandedTarget
  }
  const expanded: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (
      context === 'schema' &&
      ANNOTATION_KEYS.has(key)
    ) {
      continue
    }
    const childContext = getSchemaExpansionChildContext(context, key)
    defineRecordProperty(
      expanded,
      key,
      expandLocalReferenceValue(
        document,
        value[key],
        `${location}.${key}`,
        issues,
        state,
        depth + 1,
        childContext,
      ),
    )
  }
  if (context !== 'schema') return expanded
  try {
    return createLocalReferenceMarker(
      createHash('sha256')
        .update(serializeCanonicalJson(expanded))
        .digest('hex'),
    )
  } catch {
    addIssue(
      issues,
      'reference-contract',
      location,
      'Schema value could not be fingerprinted safely.',
    )
    return undefined
  }
}

/**
 * Canonicalizes the non-semantic order of composition-schema branches.
 *
 * Duplicate branches remain present because multiplicity affects `oneOf`.
 *
 * @param values - Compact expanded schema values.
 * @returns Values sorted by canonical semantic representation.
 */
function sortSemanticSchemaValues(values: readonly unknown[]): unknown[] {
  try {
    const decorated = values.map((value) => ({
      canonical: serializeCanonicalJson(value),
      value,
    }))
    decorated.sort((left, right) =>
      left.canonical.localeCompare(right.canonical))
    return decorated.map((entry) => entry.value)
  } catch {
    return [...values]
  }
}

/**
 * Selects the semantic role for one child of an expanded object.
 *
 * @param context - Semantic role of the owning object.
 * @param key - Child property name.
 * @returns Semantic role for the child value.
 */
function getSchemaExpansionChildContext(
  context: SchemaExpansionContext,
  key: string,
): SchemaExpansionContext {
  if (context === 'literal') return 'literal'
  if (context === 'schema') {
    if (LITERAL_VALUE_KEYS.has(key)) return 'literal'
    if (key === 'properties') return 'schema-map'
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      return 'schema-array'
    }
    if (
      key === 'additionalProperties' ||
      key === 'else' ||
      key === 'if' ||
      key === 'items' ||
      key === 'not' ||
      key === 'then' ||
      key === 'unevaluatedProperties'
    ) {
      return 'schema'
    }
    return 'semantic'
  }
  if (context === 'semantic-map') return 'semantic'
  return SEMANTIC_NAME_MAP_KEYS.has(key) ? 'semantic-map' : 'semantic'
}

/**
 * Creates one compact semantic marker for a normalized schema.
 *
 * @param semanticDigest - Digest of the resolved target semantics.
 * @returns Fixed-size marker retaining target semantics without pointer identity.
 */
function createLocalReferenceMarker(semanticDigest: string): JsonRecord {
  const marker: Record<string, unknown> = {}
  defineRecordProperty(marker, '$semanticDigest', semanticDigest)
  return marker
}

/**
 * Returns traversal state unique to one compatibility issue collector.
 *
 * @param issues - Collector identifying the current comparison run.
 * @returns Shared per-document traversal state for the run.
 */
function getSchemaTraversalContext(
  issues: IssueCollector,
): SchemaTraversalContext {
  const existing = SCHEMA_TRAVERSAL_CONTEXTS.get(issues)
  if (existing) return existing
  const created: SchemaTraversalContext = {
    expansionBudgets: new WeakMap(),
    omittedSecurityContracts: new WeakMap(),
    securityContracts: new WeakMap(),
    securitySchemeFingerprints: new WeakMap(),
    validationStates: new WeakMap(),
  }
  SCHEMA_TRAVERSAL_CONTEXTS.set(issues, created)
  return created
}

/**
 * Consumes one bounded schema traversal node and fails closed on excess work.
 *
 * @param budget - Mutable traversal accounting.
 * @param depth - Current structural traversal depth.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Whether traversal may continue at this node.
 */
function consumeSchemaTraversalBudget(
  budget: SchemaTraversalBudget,
  depth: number,
  location: string,
  issues: IssueCollector,
): boolean {
  if (budget.exceeded) return false
  budget.visitedNodes += 1
  if (
    depth <= MAX_SCHEMA_REFERENCE_DEPTH &&
    budget.visitedNodes <= MAX_SCHEMA_REFERENCE_TRAVERSAL_NODES
  ) {
    return true
  }
  budget.exceeded = true
  addIssue(
    issues,
    'reference-contract',
    location,
    'Schema reference traversal exceeded the supported depth or node budget.',
  )
  return false
}

/**
 * Resolves an object that may consist of one local `$ref`.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Object or reference.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Resolved object, or undefined when invalid.
 */
function resolveObject(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
): JsonRecord | undefined {
  return resolveObjectWithReferences(document, value, location, issues, [])
}

/**
 * Resolves transitive object references and rejects cycles.
 *
 * @param document - Owning OpenAPI document.
 * @param value - Object or reference.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @param references - Active local-reference chain.
 * @returns Fully resolved object, or undefined when invalid.
 */
function resolveObjectWithReferences(
  document: JsonRecord,
  value: unknown,
  location: string,
  issues: IssueCollector,
  references: readonly string[],
): JsonRecord | undefined {
  const object = requireRecord(value, location, issues)
  if (!object) return undefined
  if (object.$ref === undefined) return object
  if (typeof object.$ref !== 'string' || !object.$ref.startsWith('#/')) {
    addIssue(
      issues,
      'reference-contract',
      `${location}.$ref`,
      'Only local JSON Pointer references are supported.',
    )
    return undefined
  }
  if (references.includes(object.$ref)) {
    addIssue(
      issues,
      'reference-contract',
      `${location}.$ref`,
      'Cyclic local reference cannot be resolved.',
    )
    return undefined
  }
  if (references.length >= MAX_SCHEMA_REFERENCE_DEPTH) {
    addIssue(
      issues,
      'reference-contract',
      `${location}.$ref`,
      'Local reference resolution exceeded the supported depth budget.',
    )
    return undefined
  }
  const semanticSiblings = Object.keys(object).filter(
    (key) => key !== '$ref' && !ANNOTATION_KEYS.has(key),
  )
  if (semanticSiblings.length > 0) {
    addIssue(
      issues,
      'reference-contract',
      location,
      '$ref siblings contain active constraints and cannot be ignored.',
    )
    return undefined
  }
  const resolved = resolveJsonPointer(document, object.$ref)
  return resolveObjectWithReferences(
    document,
    resolved,
    `${location}->$ref(${object.$ref})`,
    issues,
    [...references, object.$ref],
  )
}

/**
 * Resolves one component object from a fixed path.
 *
 * @param document - Owning OpenAPI document.
 * @param path - Component property path.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Resolved component object, when present and valid.
 */
function resolveComponentObject(
  document: JsonRecord,
  path: readonly string[],
  location: string,
  issues: IssueCollector,
): JsonRecord | undefined {
  let current: unknown = document
  for (const segment of path) {
    if (!isJsonRecord(current)) {
      addIssue(
        issues,
        'invalid-contract',
        location,
        'Required component container is missing.',
      )
      return undefined
    }
    current = current[segment]
  }
  return resolveObject(document, current, location, issues)
}

/**
 * Resolves a local RFC 6901 JSON Pointer.
 *
 * @param document - Root JSON object.
 * @param reference - Local reference beginning with `#/`.
 * @returns Referenced value, or undefined for an invalid or absent pointer.
 */
function resolveJsonPointer(
  document: JsonRecord,
  reference: string,
): unknown {
  if (!reference.startsWith('#/')) return undefined
  let current: unknown = document
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = decodeJsonPointerSegment(encodedSegment)
    if (segment === undefined) return undefined
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!isJsonRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

/**
 * Decodes one RFC 6901 path segment and rejects invalid tilde escapes.
 *
 * @param value - Encoded pointer segment.
 * @returns Decoded property name, or undefined for an invalid escape.
 */
function decodeJsonPointerSegment(value: string): string | undefined {
  if (/~(?:[^01]|$)/.test(value)) return undefined
  return value.replaceAll('~1', '/').replaceAll('~0', '~')
}

/**
 * Compares exact object key sets.
 *
 * @param base - Base object.
 * @param candidate - Candidate object.
 * @param location - Object location.
 * @param rule - Issue rule category.
 * @param message - Failure message.
 * @param issues - Mutable issue collector.
 */
function compareExactKeySet(
  base: JsonRecord,
  candidate: JsonRecord,
  location: string,
  rule: PublicApiCompatibilityRule,
  message: string,
  issues: IssueCollector,
): void {
  const baseKeys = Object.keys(base).sort()
  const candidateKeys = Object.keys(candidate).sort()
  if (!semanticValuesEqual(baseKeys, candidateKeys)) {
    addIssue(issues, rule, location, message)
  }
}

/**
 * Compares exact semantic values while ignoring documentation annotations.
 *
 * @param base - Base value.
 * @param candidate - Candidate value.
 * @param location - Value location.
 * @param rule - Issue rule category.
 * @param message - Failure message.
 * @param issues - Mutable issue collector.
 * @param literalValue - Whether the compared root is arbitrary literal JSON.
 */
function compareExactSemanticValue(
  base: unknown,
  candidate: unknown,
  location: string,
  rule: PublicApiCompatibilityRule,
  message: string,
  issues: IssueCollector,
  literalValue = false,
): void {
  if (
    !semanticValuesEqual(
      stripAnnotations(base, false, literalValue),
      stripAnnotations(candidate, false, literalValue),
    )
  ) {
    addIssue(issues, rule, location, message)
  }
}

/**
 * Removes documentation-only properties before semantic comparison.
 *
 * @param value - Candidate value.
 * @param semanticNameMap - Whether object keys are semantic user-defined names.
 * @param literalValue - Whether the fragment is arbitrary literal JSON data.
 * @returns Value without annotation-only object properties.
 */
function stripAnnotations(
  value: unknown,
  semanticNameMap = false,
  literalValue = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      stripAnnotations(entry, false, literalValue))
  }
  if (!isJsonRecord(value)) return value
  const semantic: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (
      !literalValue &&
      !semanticNameMap &&
      ANNOTATION_KEYS.has(key)
    ) {
      continue
    }
    defineRecordProperty(
      semantic,
      key,
      stripAnnotations(
        value[key],
        !literalValue &&
          !semanticNameMap &&
          SEMANTIC_NAME_MAP_KEYS.has(key),
        literalValue ||
          (!semanticNameMap && LITERAL_VALUE_KEYS.has(key)),
      ),
    )
  }
  return semantic
}

/**
 * Copies an object without one property for separate nested comparison.
 *
 * @param value - Source object.
 * @param omittedKey - Property handled by a specialized comparator.
 * @returns Shallow object copy without the omitted property.
 */
function omitObjectKey(
  value: JsonRecord,
  omittedKey: string,
): JsonRecord {
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key !== omittedKey) defineRecordProperty(result, key, entry)
  }
  return result
}

/**
 * Compares two JSON-compatible semantic values.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether canonical JSON bytes match.
 */
function semanticValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  try {
    return serializeCanonicalJson(left) === serializeCanonicalJson(right)
  } catch {
    return false
  }
}

/**
 * Normalizes a string or string-array keyword into a set.
 *
 * @param value - Optional string or string array.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns String set, undefined for omission, or undefined after recording invalid data.
 */
function normalizeStringSet(
  value: unknown,
  location: string,
  issues: IssueCollector,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) {
    addIssue(
      issues,
      'schema-contract',
      location,
      'Schema keyword must be a string or string array.',
    )
    return undefined
  }
  return new Set(values)
}

/**
 * Normalizes an enum array into canonical JSON value strings.
 *
 * @param value - Optional enum array.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Canonical value set, or undefined when omitted or invalid.
 */
function normalizeValueSet(
  value: unknown,
  location: string,
  issues: IssueCollector,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      'schema-contract',
      location,
      'Enum must be an array.',
    )
    return undefined
  }
  try {
    return new Set(value.map((entry) => serializeCanonicalJson(entry)))
  } catch {
    addIssue(
      issues,
      'schema-contract',
      location,
      'Enum contains a non-JSON value.',
    )
    return undefined
  }
}

/**
 * Returns whether every member of one readonly set occurs in another.
 *
 * @param subset - Candidate subset.
 * @param superset - Candidate superset.
 * @returns Whether the subset relationship holds.
 */
function isSubset<T>(
  subset: ReadonlySet<T>,
  superset: ReadonlySet<T>,
): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false
  }
  return true
}

/**
 * Validates one required string property.
 *
 * @param object - Object owning the property.
 * @param property - Required property name.
 * @param location - Object diagnostic location.
 * @param rule - Stable finding category.
 * @param issues - Mutable compatibility issue collector.
 */
function validateRequiredStringProperty(
  object: JsonRecord,
  property: string,
  location: string,
  rule: PublicApiCompatibilityRule,
  issues: IssueCollector,
): void {
  if (typeof object[property] !== 'string') {
    addIssue(
      issues,
      rule,
      `${location}.${property}`,
      `Required property ${property} must be a string.`,
    )
  }
}

/**
 * Validates one optional string property when present.
 *
 * @param object - Object owning the property.
 * @param property - Optional property name.
 * @param location - Object diagnostic location.
 * @param rule - Stable finding category.
 * @param issues - Mutable compatibility issue collector.
 */
function validateOptionalStringProperty(
  object: JsonRecord,
  property: string,
  location: string,
  rule: PublicApiCompatibilityRule,
  issues: IssueCollector,
): void {
  if (
    object[property] !== undefined &&
    typeof object[property] !== 'string'
  ) {
    addIssue(
      issues,
      rule,
      `${location}.${property}`,
      `Optional property ${property} must be a string when present.`,
    )
  }
}

/**
 * Validates one optional boolean property when present.
 *
 * @param object - Object owning the property.
 * @param property - Optional property name.
 * @param location - Object diagnostic location.
 * @param rule - Stable finding category.
 * @param issues - Mutable compatibility issue collector.
 */
function validateOptionalBooleanProperty(
  object: JsonRecord,
  property: string,
  location: string,
  rule: PublicApiCompatibilityRule,
  issues: IssueCollector,
): void {
  if (
    object[property] !== undefined &&
    typeof object[property] !== 'boolean'
  ) {
    addIssue(
      issues,
      rule,
      `${location}.${property}`,
      `Optional property ${property} must be boolean when present.`,
    )
  }
}

/**
 * Validates one optional array of strings when present.
 *
 * @param object - Object owning the property.
 * @param property - Optional property name.
 * @param location - Object diagnostic location.
 * @param rule - Stable finding category.
 * @param issues - Mutable compatibility issue collector.
 */
function validateOptionalStringArrayProperty(
  object: JsonRecord,
  property: string,
  location: string,
  rule: PublicApiCompatibilityRule,
  issues: IssueCollector,
): void {
  const value = object[property]
  if (
    value !== undefined &&
    (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== 'string')
    )
  ) {
    addIssue(
      issues,
      rule,
      `${location}.${property}`,
      `Optional property ${property} must be an array of strings when present.`,
    )
  }
}

/**
 * Defines one enumerable own property without invoking the legacy `__proto__` setter.
 *
 * @param target - Mutable JSON record receiving the property.
 * @param key - Exact JSON object key.
 * @param value - JSON-compatible property value.
 */
function defineRecordProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/**
 * Converts a value into canonical JSON-safe data with cycle and sparse-array checks.
 *
 * @param value - Candidate value.
 * @param location - Diagnostic location.
 * @param ancestors - Active object recursion stack.
 * @param budget - Explicit normalization depth and node accounting.
 * @param depth - Current structural traversal depth.
 * @returns JSON-safe canonical data.
 */
function normalizeJsonValue(
  value: unknown,
  location: string,
  ancestors: Set<object>,
  budget: SchemaTraversalBudget,
  depth: number,
): unknown {
  budget.visitedNodes += 1
  if (
    depth > MAX_SCHEMA_REFERENCE_DEPTH ||
    budget.visitedNodes > MAX_SCHEMA_REFERENCE_TRAVERSAL_NODES
  ) {
    budget.exceeded = true
    throw new TypeError(
      `${location} exceeds the supported JSON depth or node budget.`,
    )
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} contains a non-finite number.`)
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${location} contains a non-JSON ${typeof value} value.`)
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${location} contains a cyclic object.`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        value.length >
        MAX_SCHEMA_REFERENCE_TRAVERSAL_NODES - budget.visitedNodes
      ) {
        budget.exceeded = true
        throw new TypeError(
          `${location} exceeds the supported JSON depth or node budget.`,
        )
      }
      const normalized: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${location} contains a sparse array slot.`)
        }
        normalized.push(
          normalizeJsonValue(
            value[index],
            `${location}[${index}]`,
            ancestors,
            budget,
            depth + 1,
          ),
        )
      }
      return normalized
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} contains a non-plain object.`)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${location} contains symbol-keyed properties.`)
    }
    if (!isJsonRecord(value)) {
      throw new TypeError(`${location} contains a non-JSON object.`)
    }
    const keys = Object.keys(value)
    if (
      keys.length >
      MAX_SCHEMA_REFERENCE_TRAVERSAL_NODES - budget.visitedNodes
    ) {
      budget.exceeded = true
      throw new TypeError(
        `${location} exceeds the supported JSON depth or node budget.`,
      )
    }
    const normalized: Record<string, unknown> = {}
    for (const key of keys.sort()) {
      defineRecordProperty(
        normalized,
        key,
        normalizeJsonValue(
          value[key],
          `${location}.${key}`,
          ancestors,
          budget,
          depth + 1,
        ),
      )
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Narrows a required value to a JSON object and records invalid shapes.
 *
 * @param value - Candidate object value.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Narrowed object, when valid.
 */
function requireRecord(
  value: unknown,
  location: string,
  issues: IssueCollector,
): JsonRecord | undefined {
  if (isJsonRecord(value)) return value
  addIssue(
    issues,
    'invalid-contract',
    location,
    'Expected an OpenAPI object.',
  )
  return undefined
}

/**
 * Narrows an optional value to a JSON object and records invalid present values.
 *
 * @param value - Optional candidate object.
 * @param location - Diagnostic location.
 * @param issues - Mutable issue collector.
 * @returns Narrowed object, or undefined when omitted or invalid.
 */
function optionalRecord(
  value: unknown,
  location: string,
  issues: IssueCollector,
): JsonRecord | undefined {
  if (value === undefined) return undefined
  return requireRecord(value, location, issues)
}

/**
 * Returns whether a value is a non-array object.
 *
 * @param value - Unknown runtime value.
 * @returns Whether the value is a JSON-object candidate.
 */
function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Appends one compatibility issue.
 *
 * @param issues - Mutable issue collector.
 * @param rule - Stable issue category.
 * @param location - Stable contract location.
 * @param message - Human-readable explanation.
 */
function addIssue(
  issues: IssueCollector,
  rule: PublicApiCompatibilityRule,
  location: string,
  message: string,
): void {
  issues.push(Object.freeze({ location, message, rule }))
}

/**
 * Removes duplicate issues produced through shared component references.
 *
 * @param issues - Raw issues in discovery order.
 * @returns Stable first-occurrence issue list.
 */
function deduplicateIssues(
  issues: readonly PublicApiCompatibilityIssue[],
): PublicApiCompatibilityIssue[] {
  const seen = new Set<string>()
  const unique: PublicApiCompatibilityIssue[] = []
  for (const issue of issues) {
    const key = `${issue.rule}\u0000${issue.location}\u0000${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(issue)
  }
  return unique
}

/**
 * Executes snapshot update/check and optional trusted-base compatibility comparison.
 *
 * @param arguments_ - CLI arguments after the script path.
 */
async function runCli(arguments_: readonly string[]): Promise<void> {
  const update = arguments_.includes('--update')
  const baseIndex = arguments_.indexOf('--base')
  const basePath = baseIndex === -1 ? undefined : arguments_[baseIndex + 1]
  const candidateIndex = arguments_.indexOf('--candidate')
  const candidatePath =
    candidateIndex === -1 ? undefined : arguments_[candidateIndex + 1]
  const bootstrapIndex = arguments_.indexOf('--bootstrap-candidate')
  const bootstrapPath =
    bootstrapIndex === -1 ? undefined : arguments_[bootstrapIndex + 1]
  const candidateSourceIndex = arguments_.indexOf('--candidate-source')
  const candidateSourcePath = candidateSourceIndex === -1
    ? undefined
    : arguments_[candidateSourceIndex + 1]
  const allowedArgumentCount =
    (update ? 1 : 0) +
    (basePath ? 2 : 0) +
    (candidatePath ? 2 : 0) +
    (bootstrapPath ? 2 : 0) +
    (candidateSourcePath ? 2 : 0)
  const candidateModeCount = [candidatePath, bootstrapPath]
    .filter((value) => value !== undefined)
    .length
  if (
    arguments_.length !== allowedArgumentCount ||
    (baseIndex !== -1 && !basePath) ||
    (candidateIndex !== -1 && !candidatePath) ||
    (bootstrapIndex !== -1 && !bootstrapPath) ||
    (candidateSourceIndex !== -1 && !candidateSourcePath) ||
    (update && (basePath || candidateModeCount > 0 || candidateSourcePath)) ||
    (basePath && (candidateModeCount > 0 || candidateSourcePath)) ||
    candidateModeCount > 1 ||
    (candidateModeCount === 1) !== Boolean(candidateSourcePath)
  ) {
    throw new TypeError(
      'Usage: check-public-api-contract.ts [--update] [--base <trusted-snapshot> | (--candidate <candidate-snapshot> | --bootstrap-candidate <candidate-snapshot>) --candidate-source <candidate-openapi-source>]',
    )
  }

  const current = serializeCanonicalJson(PUBLIC_API_OPENAPI_DOCUMENT)
  if (update) {
    await writeCanonicalSnapshotAtomically(current)
    console.log(`Updated ${SNAPSHOT_RELATIVE_PATH}.`)
    return
  }

  if (!bootstrapPath) {
    const snapshot = await readFile(SNAPSHOT_PATH, 'utf8')
    if (snapshot !== current) {
      throw new Error(
        `${SNAPSHOT_RELATIVE_PATH} is stale. Run bun run api:contract:update and review the compatibility result.`,
      )
    }
    console.log(`${SNAPSHOT_RELATIVE_PATH} matches the exported OpenAPI document.`)
  }

  if (!basePath && !candidatePath && !bootstrapPath) return
  const comparisonPath = basePath ?? candidatePath ?? bootstrapPath
  if (!comparisonPath) return
  if (candidateSourcePath) {
    await verifyCanonicalRuntimeSource(candidateSourcePath, comparisonPath)
  }
  const comparisonSource = await readFile(
    resolve(REPOSITORY_ROOT, comparisonPath),
    'utf8',
  )
  const comparisonDocument: unknown = JSON.parse(comparisonSource)
  if (serializeCanonicalJson(comparisonDocument) !== comparisonSource) {
    throw new Error(`Contract snapshot ${comparisonPath} is not canonical JSON.`)
  }
  const issues = basePath
    ? findPublicApiCompatibilityIssues(
        comparisonDocument,
        PUBLIC_API_OPENAPI_DOCUMENT,
      )
    : findPublicApiCompatibilityIssues(
        PUBLIC_API_OPENAPI_DOCUMENT,
        comparisonDocument,
      )
  if (issues.length > 0) {
    const report = issues.map((issue) =>
      `- [${issue.rule}] ${issue.location}: ${issue.message}`).join('\n')
    throw new Error(`Public API compatibility check failed:\n${report}`)
  }
  console.log(
    basePath
      ? `Public API remains compatible with ${basePath}.`
      : `${comparisonPath} remains compatible with the trusted base contract.`,
  )
}

/**
 * Replaces the canonical snapshot without following writable symlink targets.
 *
 * @param source - Canonical JSON bytes to install.
 */
async function writeCanonicalSnapshotAtomically(source: string): Promise<void> {
  const snapshotDirectory = dirname(SNAPSHOT_PATH)
  await validateSnapshotUpdateDirectory(snapshotDirectory, true)
  await validateExistingSnapshotTarget()
  const temporaryPath = resolve(
    snapshotDirectory,
    `.public-api-v1.${randomUUID()}.tmp`,
  )
  const temporaryFile = await open(temporaryPath, 'wx', 0o644)
  let closed = false
  let renamed = false
  try {
    await temporaryFile.writeFile(source, 'utf8')
    await temporaryFile.sync()
    await temporaryFile.close()
    closed = true
    const temporaryMetadata = await lstat(temporaryPath)
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.isSymbolicLink()
    ) {
      throw new Error(
        'Canonical contract update temporary target must be a regular file.',
      )
    }
    await validateSnapshotUpdateDirectory(snapshotDirectory, false)
    await validateExistingSnapshotTarget()
    await rename(temporaryPath, SNAPSHOT_PATH)
    renamed = true
  } finally {
    if (!closed) {
      await temporaryFile.close().catch(() => undefined)
    }
    if (!renamed) {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

/**
 * Validates the physical repository-owned directory used for snapshot updates.
 *
 * @param snapshotDirectory - Lexical canonical snapshot parent directory.
 * @param create - Whether a missing final directory may be created safely.
 */
async function validateSnapshotUpdateDirectory(
  snapshotDirectory: string,
  create: boolean,
): Promise<void> {
  const physicalRepositoryRoot = await realpath(REPOSITORY_ROOT)
  const contractsDirectory = resolve(REPOSITORY_ROOT, 'contracts')
  const contractsMetadata = await lstat(contractsDirectory)
  if (
    !contractsMetadata.isDirectory() ||
    contractsMetadata.isSymbolicLink() ||
    await realpath(contractsDirectory) !==
      resolve(physicalRepositoryRoot, 'contracts')
  ) {
    throw new Error(
      'Canonical contract update requires a physical repository contracts directory.',
    )
  }
  if (create) {
    try {
      await mkdir(snapshotDirectory)
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
    }
  }
  const directoryMetadata = await lstat(snapshotDirectory)
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    await realpath(snapshotDirectory) !==
      resolve(physicalRepositoryRoot, 'contracts', 'openapi')
  ) {
    throw new Error(
      'Canonical contract update requires a physical repository openapi directory.',
    )
  }
}

/**
 * Rejects an existing canonical snapshot unless it is a direct regular file.
 */
async function validateExistingSnapshotTarget(): Promise<void> {
  try {
    const metadata = await lstat(SNAPSHOT_PATH)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        'Canonical contract update target must be a regular file.',
      )
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }
}

/**
 * Checks a Node-style error code without an unsafe type assertion.
 *
 * @param error - Unknown thrown value.
 * @param code - Expected filesystem error code.
 * @returns Whether the error exposes the requested code.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return isJsonRecord(error) && error.code === code
}

/**
 * Verifies that the candidate runtime reads the canonical JSON contract directly.
 *
 * The source wrapper is intentionally immutable. A wrapper change must first
 * update and merge the trusted checker without changing the contract source.
 *
 * @param candidateSourcePath - Candidate `contracts/src/openapi.ts` path.
 * @param candidateSnapshotPath - Candidate canonical snapshot path.
 */
async function verifyCanonicalRuntimeSource(
  candidateSourcePath: string,
  candidateSnapshotPath: string,
): Promise<void> {
  const normalizedSourcePath = resolve(
    REPOSITORY_ROOT,
    candidateSourcePath,
  )
  const normalizedSnapshotPath = resolve(
    REPOSITORY_ROOT,
    candidateSnapshotPath,
  )
  const contractsDirectory = resolve(dirname(normalizedSourcePath), '..')
  const expectedSourcePath = resolve(
    contractsDirectory,
    'src',
    'openapi.ts',
  )
  const expectedSnapshotPath = resolve(
    contractsDirectory,
    'openapi',
    'public-api-v1.json',
  )
  if (
    basename(contractsDirectory) !== 'contracts' ||
    normalizedSourcePath !== expectedSourcePath ||
    normalizedSnapshotPath !== expectedSnapshotPath
  ) {
    throw new Error(
      'Candidate source and snapshot must use the contracts/src/openapi.ts and contracts/openapi/public-api-v1.json sibling layout.',
    )
  }
  const [sourceMetadata, snapshotMetadata] = await Promise.all([
    lstat(normalizedSourcePath),
    lstat(normalizedSnapshotPath),
  ])
  if (
    !sourceMetadata.isFile() ||
    sourceMetadata.isSymbolicLink() ||
    !snapshotMetadata.isFile() ||
    snapshotMetadata.isSymbolicLink()
  ) {
    throw new Error(
      'Candidate source and snapshot must be regular files in one physical contracts tree.',
    )
  }
  const [physicalSourcePath, physicalSnapshotPath] = await Promise.all([
    realpath(normalizedSourcePath),
    realpath(normalizedSnapshotPath),
  ])
  const physicalContractsDirectory = resolve(
    dirname(physicalSourcePath),
    '..',
  )
  if (
    basename(physicalContractsDirectory) !== 'contracts' ||
    physicalSourcePath !== resolve(
      physicalContractsDirectory,
      'src',
      'openapi.ts',
    ) ||
    physicalSnapshotPath !== resolve(
      physicalContractsDirectory,
      'openapi',
      'public-api-v1.json',
    )
  ) {
    throw new Error(
      'Candidate source and snapshot must be regular files in one physical contracts tree.',
    )
  }
  const source = await readFile(
    normalizedSourcePath,
    'utf8',
  )
  if (source !== CANONICAL_RUNTIME_SOURCE) {
    throw new Error(
      `${RUNTIME_SOURCE_RELATIVE_PATH} must be the trusted canonical JSON wrapper.`,
    )
  }
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown contract check failure.')
    process.exitCode = 1
  }
}
