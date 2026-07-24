import { afterEach, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_API_OPENAPI_DOCUMENT } from "../contracts/src/openapi";
import {
  findPublicApiCompatibilityIssues,
  serializeCanonicalJson,
} from "./check-public-api-contract";

const checkerPath = resolve(import.meta.dir, "check-public-api-contract.ts");
const repositoryRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const canonicalRuntimeWrapper = `import publicApiOpenApiDocumentJson from '../openapi/public-api-v1.json'

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
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })),
  );
});

/**
 * Runs the contract checker CLI with the same Bun isolation flags used by CI.
 *
 * @param arguments_ - Contract checker CLI arguments.
 * @param scriptPath - Checker entrypoint to execute.
 * @param workingDirectory - Repository root used by the isolated Bun process.
 * @returns Captured process result.
 */
async function runCheckerCli(
  arguments_: readonly string[],
  scriptPath = checkerPath,
  workingDirectory = repositoryRoot,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--config=/dev/null",
      "--no-env-file",
      "--no-install",
      `--cwd=${workingDirectory}`,
      scriptPath,
      ...arguments_,
    ],
    {
      cwd: workingDirectory,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

/**
 * Builds a representative OpenAPI document with shared and transitive schemas.
 *
 * @returns A fresh document that tests may mutate independently.
 */
function createDocument(): unknown {
  return {
    info: {
      title: "Widget API",
      version: "1.0.0",
    },
    openapi: "3.1.0",
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/widgets": {
        parameters: [
          {
            in: "query",
            name: "tenantId",
            required: false,
            schema: { type: "string" },
          },
        ],
        get: {
          description: "Gets a widget.",
          parameters: [
            {
              in: "header",
              name: "X-Trace-Id",
              required: false,
              schema: { type: "string" },
            },
          ],
          security: [
            { ApiKeyAuth: [] },
            { OAuth2: ["widgets:read"] },
          ],
          responses: {
            "200": {
              description: "A widget.",
              headers: {
                "X-Rate-Limit": {
                  required: true,
                  schema: { type: "integer", minimum: 0 },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ResponseEnvelope",
                  },
                },
              },
            },
            "404": {
              description: "The widget does not exist.",
              content: {
                "application/problem+json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WidgetInput",
                },
              },
            },
          },
          responses: {
            "201": {
              description: "The created widget.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ResponseEnvelope",
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "http",
          scheme: "bearer",
        },
        OAuth2: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "/oauth/token",
              scopes: {
                "widgets:read": "Read widgets.",
                "widgets:write": "Write widgets.",
              },
            },
          },
        },
      },
      schemas: {
        ResponseEnvelope: {
          type: "object",
          additionalProperties: true,
          required: ["data"],
          properties: {
            data: {
              $ref: "#/components/schemas/ResponsePayload",
            },
          },
        },
        ResponsePayload: {
          type: "object",
          additionalProperties: true,
          required: ["widget"],
          properties: {
            widget: {
              $ref: "#/components/schemas/Widget",
            },
          },
        },
        Widget: {
          type: "object",
          additionalProperties: false,
          required: ["id", "mode", "responseMode"],
          properties: {
            id: { type: "string" },
            mode: {
              $ref: "#/components/schemas/SharedMode",
            },
            responseMode: {
              $ref: "#/components/schemas/ResponseMode",
            },
            optionalResponse: {
              type: "string",
            },
          },
        },
        WidgetInput: {
          type: "object",
          additionalProperties: false,
          required: ["name", "mode"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
            },
            mode: {
              $ref: "#/components/schemas/SharedMode",
            },
            requestMode: {
              $ref: "#/components/schemas/RequestMode",
            },
            anything: {},
            defaultValue: true,
            note: {
              type: "string",
            },
            selector: {
              oneOf: [
                { type: "string" },
                { type: "integer" },
              ],
            },
          },
        },
        SharedMode: {
          type: "string",
          enum: ["fast", "safe"],
        },
        RequestMode: {
          type: ["string", "null"],
          enum: ["fast", null],
        },
        ResponseMode: {
          type: ["string", "null"],
          enum: ["fast", "safe", null],
        },
      },
    },
  };
}

/**
 * Clones the representative OpenAPI document.
 *
 * @returns A mutable clone.
 */
function cloneDocument(): unknown {
  return structuredClone(createDocument());
}

/**
 * Requires an unknown value to be a non-null object, including an array.
 *
 * @param value - Value to validate.
 * @param label - Fixture location used in a failure.
 * @returns The validated object.
 */
function requireObject(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  return value;
}

/**
 * Resolves an object that owns the last segment of a fixture path.
 *
 * @param root - Fixture root.
 * @param path - Property path whose parent is returned.
 * @returns The owning object and final property name.
 */
function resolveParent(
  root: unknown,
  path: readonly string[],
): readonly [object, string] {
  if (path.length === 0) {
    throw new TypeError("Fixture path must not be empty");
  }

  let current = root;
  for (const segment of path.slice(0, -1)) {
    const owner = requireObject(current, segment);
    current = Reflect.get(owner, segment);
  }

  return [
    requireObject(current, path.slice(0, -1).join(".")),
    path[path.length - 1] ?? "",
  ];
}

/**
 * Replaces or adds a property in a fixture.
 *
 * @param root - Fixture root.
 * @param path - Property path to write.
 * @param value - Replacement value.
 */
function setAtPath(
  root: unknown,
  path: readonly string[],
  value: unknown,
): void {
  const [owner, property] = resolveParent(root, path);
  if (!Reflect.set(owner, property, value)) {
    throw new TypeError(`Unable to set ${path.join(".")}`);
  }
}

/**
 * Removes a property from a fixture.
 *
 * @param root - Fixture root.
 * @param path - Property path to remove.
 */
function deleteAtPath(root: unknown, path: readonly string[]): void {
  const [owner, property] = resolveParent(root, path);
  if (!Reflect.deleteProperty(owner, property)) {
    throw new TypeError(`Unable to delete ${path.join(".")}`);
  }
}

/**
 * Requires a candidate document to have no compatibility findings.
 *
 * @param base - Previously published document.
 * @param candidate - Candidate document.
 */
function expectCompatible(base: unknown, candidate: unknown): void {
  expect(findPublicApiCompatibilityIssues(base, candidate)).toHaveLength(0);
}

/**
 * Requires a candidate document to have at least one compatibility finding.
 *
 * @param base - Previously published document.
 * @param candidate - Candidate document.
 */
function expectIncompatible(base: unknown, candidate: unknown): void {
  expect(findPublicApiCompatibilityIssues(base, candidate).length).toBeGreaterThan(
    0,
  );
}

test("accepts unchanged documents with an unchanged oneOf", () => {
  expectCompatible(createDocument(), cloneDocument());
});

test("accepts additive operations, optional request fields, and annotations", () => {
  const base = createDocument();
  const candidate = cloneDocument();

  setAtPath(candidate, ["paths", "/health"], {
    get: {
      security: [],
      responses: {
        "200": { description: "Healthy." },
      },
    },
  });
  setAtPath(candidate, ["paths", "/widgets", "put"], {
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    responses: {
      "204": { description: "Updated." },
    },
  });
  setAtPath(
    candidate,
    ["components", "schemas", "WidgetInput", "properties", "label"],
    { type: "string" },
  );
  setAtPath(
    candidate,
    ["paths", "/widgets", "get", "description"],
    "An updated annotation.",
  );

  expectCompatible(base, candidate);
});

test("validates schemas on operations introduced by a new path", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/poisoned"], {
    get: {
      responses: {
        "200": {
          description: "Poisoned.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Missing",
              },
            },
          },
        },
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("validates security, parameters, and responses on newly added methods", () => {
  const base = createDocument();

  const invalidSecurity = cloneDocument();
  setAtPath(invalidSecurity, ["paths", "/widgets", "put"], {
    security: { ApiKeyAuth: [] },
    responses: {
      "204": { description: "Updated." },
    },
  });
  expectIncompatible(base, invalidSecurity);

  const invalidParameters = cloneDocument();
  setAtPath(invalidParameters, ["paths", "/widgets", "put"], {
    parameters: {
      in: "query",
      name: "filter",
      schema: { type: "string" },
    },
    responses: {
      "204": { description: "Updated." },
    },
  });
  expectIncompatible(base, invalidParameters);

  const invalidResponse = cloneDocument();
  setAtPath(invalidResponse, ["paths", "/widgets", "put"], {
    responses: {
      "204": {
        $ref: "#/components/responses/Missing",
      },
    },
  });
  expectIncompatible(base, invalidResponse);
});

test("rejects a candidate document without the required root info", () => {
  const base = PUBLIC_API_OPENAPI_DOCUMENT;
  const candidate = structuredClone(base);
  deleteAtPath(candidate, ["info"]);

  expectIncompatible(base, candidate);
});

test("rejects a candidate response without its required description", () => {
  const base = PUBLIC_API_OPENAPI_DOCUMENT;
  const candidate = structuredClone(base);
  deleteAtPath(candidate, [
    "paths",
    "/api/v1/openapi.json",
    "get",
    "responses",
    "200",
    "description",
  ]);

  expectIncompatible(base, candidate);
});

test("rejects a non-boolean required value on an existing request body", () => {
  const base = PUBLIC_API_OPENAPI_DOCUMENT;
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "paths",
      "/api/v1/oauth/token",
      "post",
      "requestBody",
      "required",
    ],
    "yes",
  );

  expectIncompatible(base, candidate);
});

test("rejects malformed request and response objects on a new operation", () => {
  const base = PUBLIC_API_OPENAPI_DOCUMENT;
  const candidate = structuredClone(base);
  setAtPath(candidate, ["paths", "/api/v1/malformed"], {
    post: {
      requestBody: {
        required: "yes",
      },
      responses: {
        "200": {},
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("rejects malformed path keys and missing template parameters", () => {
  const base = createDocument();
  const missingSlash = cloneDocument();
  setAtPath(missingSlash, ["paths", "widgets"], {
    get: {
      responses: {
        "200": { description: "Invalid path key." },
      },
    },
  });
  expectIncompatible(base, missingSlash);

  const missingParameter = cloneDocument();
  setAtPath(missingParameter, ["paths", "/widgets/{widgetId}"], {
    get: {
      responses: {
        "200": { description: "Missing path parameter." },
      },
    },
  });
  expectIncompatible(base, missingParameter);
});

test("rejects malformed and ambiguous path templates", () => {
  const base = createDocument();
  const malformed = cloneDocument();
  setAtPath(malformed, ["paths", "/widgets/{widgetId"], {
    get: {
      responses: {
        "200": { description: "Malformed path template." },
      },
    },
  });
  expectIncompatible(base, malformed);

  const ambiguous = cloneDocument();
  for (const parameterName of ["id", "name"]) {
    setAtPath(ambiguous, ["paths", `/aliases/{${parameterName}}`], {
      get: {
        parameters: [
          {
            in: "path",
            name: parameterName,
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Ambiguous path template." },
        },
      },
    });
  }
  expectIncompatible(base, ambiguous);
});

test("rejects unsupported response keys on additive operations", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/invalid-response-key"], {
    get: {
      responses: {
        banana: { description: "Not a response status." },
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("validates unreferenced Path Item components", () => {
  const base = createDocument();
  const nonObjectCandidate = cloneDocument();
  setAtPath(
    nonObjectCandidate,
    ["components", "pathItems"],
    { Bad: 42 },
  );
  expectIncompatible(base, nonObjectCandidate);

  const missingResponsesCandidate = cloneDocument();
  setAtPath(
    missingResponsesCandidate,
    ["components", "pathItems"],
    { Bad: { get: {} } },
  );
  expectIncompatible(base, missingResponsesCandidate);
});

test("accepts one concrete path through aliased Path Item components", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["components", "pathItems"], {
    Alias: {
      $ref: "#/components/pathItems/Target",
    },
    Target: {
      get: {
        operationId: "readAliasedPath",
        responses: {
          "200": { description: "Aliased." },
        },
      },
    },
  });
  setAtPath(candidate, ["paths", "/aliased"], {
    $ref: "#/components/pathItems/Alias",
  });

  expectCompatible(base, candidate);
});

test("rejects unsupported JSON Schema type names", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "UnsupportedType"],
    { type: "banana" },
  );

  expectIncompatible(base, candidate);
});

test("follows transitive Path Item references when comparing operations", () => {
  const base = createDocument();
  setAtPath(base, ["components", "pathItems"], {
    WidgetsAlias: {
      $ref: "#/components/pathItems/WidgetsTarget",
    },
    WidgetsTarget: {
      get: {
        responses: {
          "200": {
            description: "Referenced response.",
            content: {
              "application/json": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
  });
  setAtPath(base, ["paths", "/widgets"], {
    $ref: "#/components/pathItems/WidgetsAlias",
  });
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "components",
      "pathItems",
      "WidgetsTarget",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
      "type",
    ],
    "integer",
  );

  expectIncompatible(base, candidate);
});

test("rejects unresolved Path Item references on additive paths", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/missing"], {
    $ref: "#/components/pathItems/Missing",
  });

  expectIncompatible(base, candidate);
});

test("rejects referenced callbacks even on additive operations", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["components", "callbacks"], {
    WidgetEvent: {
      "{$request.body#/callbackUrl}": {
        post: {
          responses: {
            "204": { description: "Accepted." },
          },
        },
      },
    },
  });
  setAtPath(candidate, ["paths", "/events"], {
    post: {
      callbacks: {
        widgetEvent: {
          $ref: "#/components/callbacks/WidgetEvent",
        },
      },
      responses: {
        "202": { description: "Registered." },
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("rejects response links on existing and additive responses", () => {
  const base = createDocument();

  const existingResponse = cloneDocument();
  setAtPath(
    existingResponse,
    ["paths", "/widgets", "get", "responses", "200", "links"],
    {
      self: {
        operationId: "getWidget",
      },
    },
  );
  expectIncompatible(base, existingResponse);

  const additiveResponse = cloneDocument();
  setAtPath(additiveResponse, ["paths", "/linked"], {
    get: {
      responses: {
        "200": {
          description: "Linked.",
          links: {
            self: {
              $ref: "#/components/links/Self",
            },
          },
        },
      },
    },
  });
  expectIncompatible(base, additiveResponse);
});

const expandedResponseSurfaceMutations: ReadonlyArray<
  readonly [string, (document: unknown) => void]
> = [
  [
    "response status",
    (document) => {
      setAtPath(
        document,
        ["paths", "/widgets", "get", "responses", "206"],
        { description: "A partial widget page." },
      );
    },
  ],
  [
    "response media type",
    (document) => {
      setAtPath(
        document,
        [
          "paths",
          "/widgets",
          "get",
          "responses",
          "200",
          "content",
          "text/json",
        ],
        {
          schema: {
            $ref: "#/components/schemas/ResponseEnvelope",
          },
        },
      );
    },
  ],
  [
    "response header",
    (document) => {
      setAtPath(
        document,
        [
          "paths",
          "/widgets",
          "get",
          "responses",
          "200",
          "headers",
          "X-New",
        ],
        { schema: { type: "string" } },
      );
    },
  ],
];

for (const [surface, mutate] of expandedResponseSurfaceMutations) {
  test(`rejects an added ${surface} on an existing operation`, () => {
    const base = createDocument();
    const candidate = cloneDocument();
    mutate(candidate);

    expectIncompatible(base, candidate);
  });
}

const removedSurfaceMutations: ReadonlyArray<
  readonly [string, (document: unknown) => void]
> = [
  [
    "path",
    (document) => {
      deleteAtPath(document, ["paths", "/widgets"]);
    },
  ],
  [
    "method",
    (document) => {
      deleteAtPath(document, ["paths", "/widgets", "get"]);
    },
  ],
  [
    "status",
    (document) => {
      deleteAtPath(document, [
        "paths",
        "/widgets",
        "get",
        "responses",
        "404",
      ]);
    },
  ],
  [
    "response media type",
    (document) => {
      deleteAtPath(document, [
        "paths",
        "/widgets",
        "get",
        "responses",
        "200",
        "content",
        "application/json",
      ]);
    },
  ],
  [
    "request media type",
    (document) => {
      deleteAtPath(document, [
        "paths",
        "/widgets",
        "post",
        "requestBody",
        "content",
        "application/json",
      ]);
    },
  ],
  [
    "response header",
    (document) => {
      deleteAtPath(document, [
        "paths",
        "/widgets",
        "get",
        "responses",
        "200",
        "headers",
        "X-Rate-Limit",
      ]);
    },
  ],
];

for (const [surface, mutate] of removedSurfaceMutations) {
  test(`rejects a removed ${surface}`, () => {
    const base = createDocument();
    const candidate = cloneDocument();
    mutate(candidate);

    expectIncompatible(base, candidate);
  });
}

test("rejects a removed parameter", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "parameters"], []);

  expectIncompatible(base, candidate);
});

test("rejects an optional parameter becoming required", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["paths", "/widgets", "parameters", "0", "required"],
    true,
  );

  expectIncompatible(base, candidate);
});

test("rejects a new required parameter on an existing operation", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "parameters", "1"], {
    in: "query",
    name: "requiredFilter",
    required: true,
    schema: { type: "string" },
  });

  expectIncompatible(base, candidate);
});

test("rejects an existing path parameter that omits required true", () => {
  const base = createDocument();
  setAtPath(base, ["paths", "/widgets", "get", "parameters", "1"], {
    in: "path",
    name: "widgetId",
    schema: { type: "string" },
  });
  const candidate = structuredClone(base);

  expectIncompatible(base, candidate);
});

test("rejects a newly added path parameter that omits required true", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "parameters", "1"], {
    in: "path",
    name: "widgetId",
    schema: { type: "string" },
  });

  expectIncompatible(base, candidate);
});

test("rejects a new required request body on an existing operation", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "requestBody"], {
    required: true,
    content: {
      "application/json": {
        schema: { type: "object" },
      },
    },
  });

  expectIncompatible(base, candidate);
});

const requestNarrowingMutations: ReadonlyArray<
  readonly [string, (document: unknown) => void]
> = [
  [
    "request enum value removal",
    (document) => {
      setAtPath(
        document,
        ["components", "schemas", "SharedMode", "enum"],
        ["fast"],
      );
    },
  ],
  [
    "new required request property",
    (document) => {
      setAtPath(
        document,
        ["components", "schemas", "WidgetInput", "required"],
        ["name", "mode", "note"],
      );
    },
  ],
  [
    "request property removal",
    (document) => {
      deleteAtPath(document, [
        "components",
        "schemas",
        "WidgetInput",
        "properties",
        "note",
      ]);
    },
  ],
  [
    "request minimum narrowing",
    (document) => {
      setAtPath(
        document,
        [
          "components",
          "schemas",
          "WidgetInput",
          "properties",
          "name",
          "minLength",
        ],
        2,
      );
    },
  ],
];

for (const [change, mutate] of requestNarrowingMutations) {
  test(`rejects ${change}`, () => {
    const base = createDocument();
    const candidate = cloneDocument();
    mutate(candidate);

    expectIncompatible(base, candidate);
  });
}

const responseExpansionMutations: ReadonlyArray<
  readonly [string, (document: unknown) => void]
> = [
  [
    "a required response property becoming optional",
    (document) => {
      setAtPath(
        document,
        ["components", "schemas", "Widget", "required"],
        ["mode"],
      );
    },
  ],
  [
    "a response property type change",
    (document) => {
      setAtPath(
        document,
        [
          "components",
          "schemas",
          "Widget",
          "properties",
          "id",
          "type",
        ],
        "integer",
      );
    },
  ],
  [
    "a response enum expansion",
    (document) => {
      setAtPath(
        document,
        ["components", "schemas", "SharedMode", "enum"],
        ["fast", "safe", "turbo"],
      );
    },
  ],
  [
    "a response property addition when additional properties are forbidden",
    (document) => {
      setAtPath(
        document,
        ["components", "schemas", "Widget", "properties", "debug"],
        { type: "string" },
      );
    },
  ],
];

for (const [change, mutate] of responseExpansionMutations) {
  test(`rejects ${change}`, () => {
    const base = createDocument();
    const candidate = cloneDocument();
    mutate(candidate);

    expectIncompatible(base, candidate);
  });
}

test("uses base additionalProperties for candidate-only request properties", () => {
  const openBase = createDocument();
  setAtPath(
    openBase,
    ["components", "schemas", "WidgetInput", "additionalProperties"],
    true,
  );
  const constrainedOpenCandidate = structuredClone(openBase);
  setAtPath(
    constrainedOpenCandidate,
    ["components", "schemas", "WidgetInput", "properties", "newField"],
    { type: "string" },
  );
  expectIncompatible(openBase, constrainedOpenCandidate);

  const closedBase = createDocument();
  const expandedClosedCandidate = structuredClone(closedBase);
  setAtPath(
    expandedClosedCandidate,
    ["components", "schemas", "WidgetInput", "properties", "newField"],
    { type: "string" },
  );
  expectCompatible(closedBase, expandedClosedCandidate);

  const schemaBase = createDocument();
  setAtPath(
    schemaBase,
    ["components", "schemas", "WidgetInput", "additionalProperties"],
    { type: "string" },
  );
  const narrowedSchemaCandidate = structuredClone(schemaBase);
  setAtPath(
    narrowedSchemaCandidate,
    ["components", "schemas", "WidgetInput", "properties", "newField"],
    { type: "string", minLength: 1 },
  );
  expectIncompatible(schemaBase, narrowedSchemaCandidate);
});

test("uses base additionalProperties for candidate-only response properties", () => {
  const closedBase = createDocument();
  const expandedClosedCandidate = structuredClone(closedBase);
  setAtPath(
    expandedClosedCandidate,
    ["components", "schemas", "Widget", "properties", "newField"],
    { type: "string" },
  );
  expectIncompatible(closedBase, expandedClosedCandidate);

  const openBase = createDocument();
  setAtPath(
    openBase,
    ["components", "schemas", "Widget", "additionalProperties"],
    true,
  );
  const constrainedOpenCandidate = structuredClone(openBase);
  setAtPath(
    constrainedOpenCandidate,
    ["components", "schemas", "Widget", "properties", "newField"],
    { type: "string" },
  );
  expectCompatible(openBase, constrainedOpenCandidate);

  const schemaBase = createDocument();
  setAtPath(
    schemaBase,
    ["components", "schemas", "Widget", "additionalProperties"],
    { type: "string" },
  );
  const widenedSchemaCandidate = structuredClone(schemaBase);
  setAtPath(
    widenedSchemaCandidate,
    ["components", "schemas", "Widget", "properties", "newField"],
    { type: ["string", "number"] },
  );
  expectIncompatible(schemaBase, widenedSchemaCandidate);
});

test("distinguishes security OR alternatives from an AND requirement", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "security"], [
    {
      ApiKeyAuth: [],
      OAuth2: ["widgets:read"],
    },
  ]);

  expectIncompatible(base, candidate);
});

test("rejects an operation security scope change", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "get", "security"], [
    { ApiKeyAuth: [] },
    { OAuth2: ["widgets:write"] },
  ]);

  expectIncompatible(base, candidate);
});

test("uses inherited root security when comparing an operation", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["security"], [
    { OAuth2: ["widgets:write"] },
  ]);

  expectIncompatible(base, candidate);
});

test("follows transitive response references", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "Widget", "properties", "id", "type"],
    "boolean",
  );

  expectIncompatible(base, candidate);
});

test("rejects a changed oneOf composition", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [
      { type: "string" },
      { type: "integer" },
      { type: "boolean" },
    ],
  );

  expectIncompatible(base, candidate);
});

test("accepts a pure reorder of composition branches", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [
      { type: "integer" },
      { type: "string" },
    ],
  );

  expectCompatible(base, candidate);
});

test("accepts a composition refactor to an equivalent schema target", () => {
  const base = createDocument();
  setAtPath(base, ["components", "schemas", "EquivalentA"], {
    type: "string",
  });
  setAtPath(base, ["components", "schemas", "EquivalentB"], {
    type: "string",
  });
  setAtPath(
    base,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [{ $ref: "#/components/schemas/EquivalentA" }],
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [{ $ref: "#/components/schemas/EquivalentB" }],
  );

  expectCompatible(base, candidate);

  const inlineCandidate = structuredClone(base);
  setAtPath(
    inlineCandidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [{ type: "string" }],
  );
  expectCompatible(base, inlineCandidate);
});

test("rejects non-canonical schema set arrays", () => {
  const base = createDocument();
  const duplicateTypes = cloneDocument();
  setAtPath(
    duplicateTypes,
    ["components", "schemas", "RequestMode", "type"],
    ["string", "string"],
  );
  expectIncompatible(base, duplicateTypes);

  const emptyEnum = cloneDocument();
  setAtPath(
    emptyEnum,
    ["components", "schemas", "RequestMode", "enum"],
    [],
  );
  expectIncompatible(base, emptyEnum);

  const duplicateRequired = cloneDocument();
  setAtPath(
    duplicateRequired,
    ["components", "schemas", "WidgetInput", "required"],
    ["name", "name"],
  );
  expectIncompatible(base, duplicateRequired);
});

test("recursively validates composition schemas and schema reference targets", () => {
  const base = createDocument();
  const invalidType = cloneDocument();
  setAtPath(invalidType, ["components", "schemas", "InvalidResponse"], {
    allOf: [{ type: "banana" }],
  });
  setAtPath(invalidType, ["paths", "/invalid-composition"], {
    get: {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InvalidResponse",
              },
            },
          },
          description: "Invalid composition.",
        },
      },
    },
  });
  expectIncompatible(base, invalidType);

  const invalidTarget = cloneDocument();
  setAtPath(invalidTarget, ["components", "schemas", "InvalidResponse"], {
    allOf: [{ $ref: "#/info/title" }],
  });
  setAtPath(invalidTarget, ["paths", "/invalid-reference-target"], {
    get: {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/InvalidResponse",
              },
            },
          },
          description: "Invalid reference target.",
        },
      },
    },
  });
  expectIncompatible(base, invalidTarget);
});

test("rejects invalid numeric schema keyword domains", () => {
  const base = createDocument();
  const cases = [
    {
      path: ["components", "schemas", "RequestMode", "multipleOf"],
      value: 0,
    },
    {
      path: [
        "components",
        "schemas",
        "WidgetInput",
        "properties",
        "name",
        "minLength",
      ],
      value: -1,
    },
    {
      path: ["components", "schemas", "WidgetInput", "minItems"],
      value: 1.5,
    },
  ];
  for (const invalidCase of cases) {
    const candidate = cloneDocument();
    setAtPath(candidate, invalidCase.path, invalidCase.value);
    expectIncompatible(base, candidate);
  }
});

test("reports one exact schema finding for an invalid additive operation", () => {
  const base = {
    info: { title: "Diagnostics", version: "1.0.0" },
    openapi: "3.1.0",
    paths: {},
  };
  const candidate = structuredClone(base);
  setAtPath(candidate, ["paths", "/diagnostic"], {
    get: {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { type: "banana" },
            },
          },
          description: "Diagnostic response.",
        },
      },
    },
  });

  expect(findPublicApiCompatibilityIssues(base, candidate)).toEqual([
    {
      location:
        '$.paths["/diagnostic"].get.responses["200"].content["application/json"].schema.type',
      message: 'Unsupported schema type "banana".',
      rule: "schema-contract",
    },
  ]);
});

test("fails closed for an unresolved local reference", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "Widget", "properties", "id"],
    { $ref: "#/components/schemas/Missing" },
  );

  expectIncompatible(base, candidate);
});

test("fails closed for an external reference", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "Widget", "properties", "id"],
    { $ref: "https://schemas.example.test/common.json#/WidgetId" },
  );

  expectIncompatible(base, candidate);
});

test("fails closed for cyclic references without hanging", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["components", "schemas", "CycleA"], {
    $ref: "#/components/schemas/CycleB",
  });
  setAtPath(candidate, ["components", "schemas", "CycleB"], {
    $ref: "#/components/schemas/CycleA",
  });
  setAtPath(
    candidate,
    ["components", "schemas", "Widget", "properties", "id"],
    { $ref: "#/components/schemas/CycleA" },
  );

  expectIncompatible(base, candidate);
});

test("fails closed for unchanged recursive schemas without overflowing", () => {
  const base = createDocument();
  setAtPath(base, ["components", "schemas", "RecursiveWidget"], {
    type: "object",
    properties: {
      next: {
        $ref: "#/components/schemas/RecursiveWidget",
      },
    },
  });
  setAtPath(
    base,
    ["components", "schemas", "Widget", "properties", "recursive"],
    {
      $ref: "#/components/schemas/RecursiveWidget",
    },
  );
  const candidate = structuredClone(base);

  expectIncompatible(base, candidate);
});

test("compares a 20-level two-branch reference DAG within a bounded time", () => {
  const base = createDocument();
  for (let level = 20; level >= 0; level -= 1) {
    const name = `Dag${level}`;
    const schema = level === 20
      ? { type: "string" }
      : {
          oneOf: [
            { $ref: `#/components/schemas/Dag${level + 1}` },
            { $ref: `#/components/schemas/Dag${level + 1}` },
          ],
        };
    setAtPath(base, ["components", "schemas", name], schema);
  }
  setAtPath(
    base,
    ["components", "schemas", "WidgetInput", "properties", "selector"],
    { $ref: "#/components/schemas/Dag0" },
  );
  const candidate = structuredClone(base);
  const startedAt = performance.now();

  expectCompatible(base, candidate);
  const changedLeafCandidate = structuredClone(base);
  setAtPath(
    changedLeafCandidate,
    ["components", "schemas", "Dag20", "type"],
    "integer",
  );
  expectIncompatible(base, changedLeafCandidate);

  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("rejects a deep reference chain despite bottom-up component memoization", () => {
  const base = {
    info: {
      title: "Depth budget",
      version: "1.0.0",
    },
    openapi: "3.1.0",
    paths: {},
  };
  const candidate = structuredClone(base);
  setAtPath(candidate, ["components"], { schemas: {} });
  for (let level = 130; level >= 0; level -= 1) {
    setAtPath(
      candidate,
      ["components", "schemas", `C${level}`],
      level === 130
        ? { type: "string" }
        : {
            properties: {
              next: {
                $ref: `#/components/schemas/C${level + 1}`,
              },
            },
            type: "object",
          },
    );
  }
  setAtPath(candidate, ["paths", "/deep"], {
    get: {
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/C0",
              },
            },
          },
          description: "Deep response.",
        },
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("rejects a shared schema enum addition through its response use", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "SharedMode", "enum"],
    ["fast", "safe", "turbo"],
  );

  expectIncompatible(base, candidate);
});

test("rejects a shared schema enum removal through its request use", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "SharedMode", "enum"],
    ["fast"],
  );

  expectIncompatible(base, candidate);
});

test("accepts a request-only enum expansion", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "RequestMode", "enum"],
    ["fast", "safe", null],
  );

  expectCompatible(base, candidate);
});

test("accepts a response-only enum contraction", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "ResponseMode", "enum"],
    ["fast", null],
  );

  expectCompatible(base, candidate);
});

test("accepts removal of a request required property", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "WidgetInput", "required"],
    ["name"],
  );

  expectCompatible(base, candidate);
});

test("accepts making an existing response property required", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["components", "schemas", "Widget", "required"],
    ["id", "mode", "responseMode", "optionalResponse"],
  );

  expectCompatible(base, candidate);
});

test("uses directional variance for nullable type arrays", () => {
  const base = createDocument();
  const requestCandidate = cloneDocument();
  setAtPath(
    requestCandidate,
    ["components", "schemas", "RequestMode", "type"],
    ["string"],
  );
  expectIncompatible(base, requestCandidate);

  const responseCandidate = cloneDocument();
  setAtPath(
    responseCandidate,
    ["components", "schemas", "ResponseMode", "type"],
    ["string"],
  );
  setAtPath(
    responseCandidate,
    ["components", "schemas", "ResponseMode", "enum"],
    ["fast", "safe"],
  );
  expectCompatible(base, responseCandidate);
});

test("rejects operationId and root server URL changes", () => {
  const base = createDocument();
  const operationCandidate = cloneDocument();
  setAtPath(
    operationCandidate,
    ["paths", "/widgets", "get", "operationId"],
    "getWidget",
  );
  expectIncompatible(base, operationCandidate);

  const serverCandidate = cloneDocument();
  setAtPath(serverCandidate, ["servers"], [{ url: "https://api.example.test" }]);
  expectIncompatible(base, serverCandidate);
});

test("rejects unsupported schema keywords and active ref siblings", () => {
  const base = createDocument();
  const unknownKeywordCandidate = cloneDocument();
  setAtPath(
    unknownKeywordCandidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "name",
      "contains",
    ],
    { type: "string" },
  );
  expectIncompatible(base, unknownKeywordCandidate);

  const refSiblingCandidate = cloneDocument();
  setAtPath(
    refSiblingCandidate,
    ["components", "schemas", "Widget", "properties", "mode", "minLength"],
    1,
  );
  expectIncompatible(base, refSiblingCandidate);
});

test("handles empty and boolean JSON Schemas explicitly", () => {
  const base = createDocument();
  const narrowedOpenSchemaCandidate = cloneDocument();
  setAtPath(
    narrowedOpenSchemaCandidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "anything",
    ],
    { type: "string" },
  );
  expectIncompatible(base, narrowedOpenSchemaCandidate);

  const booleanSchemaCandidate = cloneDocument();
  setAtPath(
    booleanSchemaCandidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "defaultValue",
    ],
    false,
  );
  expectIncompatible(base, booleanSchemaCandidate);
});

test("treats header parameter names as case-insensitive", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    ["paths", "/widgets", "get", "parameters", "0", "name"],
    "x-trace-id",
  );

  expectCompatible(base, candidate);
});

test("distinguishes inherited security from an explicit anonymous operation", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/widgets", "post", "security"], []);

  expectIncompatible(base, candidate);
});

test("ignores OAuth scope descriptions while retaining scope names", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(
    candidate,
    [
      "components",
      "securitySchemes",
      "OAuth2",
      "flows",
      "clientCredentials",
      "scopes",
      "widgets:read",
    ],
    "Updated annotation.",
  );

  expectCompatible(base, candidate);
});

test("retains semantic schema property names that match annotation keywords", () => {
  const base = createDocument();
  setAtPath(
    base,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
    ],
    [
      {
        type: "object",
        properties: {
          description: { type: "string" },
          title: { type: "string" },
        },
      },
    ],
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "oneOf",
      "0",
      "properties",
      "description",
      "type",
    ],
    "integer",
  );

  expectIncompatible(base, candidate);
});

test("retains semantic server variable names that match annotation keywords", () => {
  const base = createDocument();
  setAtPath(base, ["servers"], [
    {
      url: "https://{description}.{title}.example.test",
      variables: {
        description: { default: "api" },
        title: { default: "public" },
      },
    },
  ]);
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    ["servers", "0", "variables", "description", "default"],
    "private",
  );

  expectIncompatible(base, candidate);
});

test("retains encoding property names that match annotation keywords", () => {
  const base = createDocument();
  setAtPath(
    base,
    [
      "paths",
      "/widgets",
      "post",
      "requestBody",
      "content",
      "application/json",
      "encoding",
    ],
    {
      description: { style: "form" },
      title: { style: "form" },
    },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "paths",
      "/widgets",
      "post",
      "requestBody",
      "content",
      "application/json",
      "encoding",
      "description",
      "style",
    ],
    "spaceDelimited",
  );

  expectIncompatible(base, candidate);
});

test("retains encoding header names that match annotation keywords", () => {
  const base = createDocument();
  setAtPath(
    base,
    [
      "paths",
      "/widgets",
      "post",
      "requestBody",
      "content",
      "application/json",
      "encoding",
    ],
    {
      upload: {
        headers: {
          description: {
            schema: { type: "string" },
          },
          title: {
            schema: { type: "string" },
          },
        },
      },
    },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "paths",
      "/widgets",
      "post",
      "requestBody",
      "content",
      "application/json",
      "encoding",
      "upload",
      "headers",
      "description",
      "schema",
      "type",
    ],
    "integer",
  );

  expectIncompatible(base, candidate);
});

test("compares Header content schemas in the response direction", () => {
  const base = createDocument();
  setAtPath(base, ["components", "schemas", "HeaderMode"], {
    enum: ["fast"],
    type: "string",
  });
  setAtPath(
    base,
    [
      "paths",
      "/widgets",
      "get",
      "responses",
      "200",
      "headers",
      "X-Mode",
    ],
    {
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/HeaderMode",
          },
        },
      },
    },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    ["components", "schemas", "HeaderMode", "enum"],
    ["fast", "safe"],
  );

  expectIncompatible(base, candidate);
});

test("compares encoding Header schemas in the request direction", () => {
  const base = createDocument();
  setAtPath(base, ["components", "schemas", "EncodingMode"], {
    enum: ["fast", "safe"],
    type: "string",
  });
  setAtPath(
    base,
    [
      "paths",
      "/widgets",
      "post",
      "requestBody",
      "content",
      "application/json",
      "encoding",
    ],
    {
      mode: {
        headers: {
          "X-Mode": {
            schema: {
              $ref: "#/components/schemas/EncodingMode",
            },
          },
        },
      },
    },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    ["components", "schemas", "EncodingMode", "enum"],
    ["fast"],
  );

  expectIncompatible(base, candidate);
});

test("validates encoding header object shapes on additive operations", () => {
  const base = createDocument();
  const candidate = cloneDocument();
  setAtPath(candidate, ["paths", "/uploads"], {
    post: {
      requestBody: {
        content: {
          "multipart/form-data": {
            encoding: {
              upload: {
                headers: {
                  "X-Mode": 42,
                },
              },
            },
            schema: {
              properties: {
                upload: { type: "string" },
              },
              type: "object",
            },
          },
        },
      },
      responses: {
        "204": { description: "Uploaded." },
      },
    },
  });

  expectIncompatible(base, candidate);
});

test("retains discriminator mapping names that match annotation keywords", () => {
  const base = createDocument();
  setAtPath(
    base,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "discriminator",
    ],
    {
      propertyName: "kind",
      mapping: {
        description: "#/components/schemas/RequestMode",
        title: "#/components/schemas/SharedMode",
      },
    },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "selector",
      "discriminator",
      "mapping",
      "description",
    ],
    "#/components/schemas/SharedMode",
  );

  expectIncompatible(base, candidate);
});

test("retains annotation-like keys inside literal schema defaults", () => {
  const base = createDocument();
  setAtPath(
    base,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "note",
      "default",
    ],
    { description: "base", title: "literal" },
  );
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    [
      "components",
      "schemas",
      "WidgetInput",
      "properties",
      "note",
      "default",
      "description",
    ],
    "candidate",
  );

  expectIncompatible(base, candidate);
});

test("validates many additive paths and inherited schemes within a bounded time", () => {
  const base = {
    info: { title: "Security scaling", version: "1.0.0" },
    openapi: "3.1.0",
    paths: {},
  };
  const paths: Record<string, unknown> = {};
  const schemes: Record<string, unknown> = {};
  const requirement: Record<string, unknown> = {};
  for (let index = 0; index < 800; index += 1) {
    const schemeName = `Scheme${index}`;
    schemes[schemeName] = {
      scheme: "bearer",
      type: "http",
    };
    requirement[schemeName] = [];
    paths[`/scaled/${index}`] = {
      get: {
        responses: {
          "204": { description: "Scaled." },
        },
      },
    };
  }
  const candidate = {
    components: {
      securitySchemes: schemes,
    },
    info: { title: "Security scaling", version: "1.0.0" },
    openapi: "3.1.0",
    paths,
    security: [requirement],
  };
  const startedAt = performance.now();

  expectCompatible(base, candidate);
  expectCompatible(candidate, structuredClone(candidate));
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});

test("canonical serialization is independent of object insertion order", () => {
  const first = {
    zebra: 1,
    alpha: {
      second: true,
      first: false,
    },
  };
  const second = {
    alpha: {
      first: false,
      second: true,
    },
    zebra: 1,
  };

  expect(serializeCanonicalJson(first)).toBe(serializeCanonicalJson(second));
});

test("canonical serialization preserves an own __proto__ JSON key", () => {
  const value: unknown = JSON.parse(
    '{"safe":true,"__proto__":{"polluted":false}}',
  );
  const serialized = serializeCanonicalJson(value);
  const reparsed: unknown = JSON.parse(serialized);

  expect(serialized).toContain('"__proto__"');
  expect(Object.hasOwn(requireObject(reparsed, "serialized JSON"), "__proto__"))
    .toBe(true);
});

test("semantic normalization preserves an own __proto__ server variable", () => {
  const base = createDocument();
  const serverDefinitions: unknown = JSON.parse(
    '[{"url":"https://{__proto__}.example.test","variables":{"__proto__":{"default":"public"}}}]',
  );
  setAtPath(base, ["servers"], serverDefinitions);
  const candidate = structuredClone(base);
  setAtPath(
    candidate,
    ["servers", "0", "variables", "__proto__", "default"],
    "private",
  );

  expectIncompatible(base, candidate);
});

test("canonical serialization rejects excessive structural depth", () => {
  let value: unknown = null;
  for (let depth = 0; depth < 130; depth += 1) {
    value = [value];
  }

  expect(() => serializeCanonicalJson(value)).toThrow(
    "exceeds the supported JSON depth or node budget",
  );
});

const sparseArray: unknown[] = [];
sparseArray.length = 1;

const unsupportedCanonicalValues = new Map<string, unknown>([
  ["undefined", undefined],
  ["a function", Math.max],
  ["NaN", Number.NaN],
  ["a bigint", BigInt(1)],
  ["a sparse array", sparseArray],
  ["a symbol", Symbol("not-json")],
]);

for (const [label, value] of unsupportedCanonicalValues) {
  test(`canonical serialization rejects ${label}`, () => {
    expect(() => serializeCanonicalJson(value)).toThrow();
  });
}

test("bootstrap CLI binds a canonical snapshot to the immutable runtime wrapper", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "mukuroji-public-api-contract-"),
  );
  temporaryDirectories.push(directory);
  const contractsDirectory = join(directory, "contract-head", "contracts");
  const snapshotPath = join(
    contractsDirectory,
    "openapi",
    "public-api-v1.json",
  );
  const sourcePath = join(contractsDirectory, "src", "openapi.ts");
  await mkdir(join(contractsDirectory, "openapi"), { recursive: true });
  await mkdir(join(contractsDirectory, "src"), { recursive: true });
  const currentSnapshot = serializeCanonicalJson(
    PUBLIC_API_OPENAPI_DOCUMENT,
  );
  await writeFile(snapshotPath, currentSnapshot, "utf8");
  await writeFile(sourcePath, canonicalRuntimeWrapper, "utf8");

  const compatible = await runCheckerCli([
    "--bootstrap-candidate",
    snapshotPath,
    "--candidate-source",
    sourcePath,
  ]);
  expect(compatible.exitCode).toBe(0);
  expect(compatible.stdout).toContain(
    "remains compatible with the trusted base contract",
  );

  const unrelatedSnapshotPath = join(directory, "public-api-v1.json");
  await writeFile(unrelatedSnapshotPath, currentSnapshot, "utf8");
  const unrelated = await runCheckerCli([
    "--bootstrap-candidate",
    unrelatedSnapshotPath,
    "--candidate-source",
    sourcePath,
  ]);
  expect(unrelated.exitCode).toBe(1);
  expect(unrelated.stderr).toContain(
    "must use the contracts/src/openapi.ts and contracts/openapi/public-api-v1.json sibling layout",
  );

  const linkedContractsDirectory = join(
    directory,
    "linked-head",
    "contracts",
  );
  const externalSourceDirectory = join(directory, "external-src");
  const linkedSnapshotPath = join(
    linkedContractsDirectory,
    "openapi",
    "public-api-v1.json",
  );
  const linkedSourcePath = join(
    linkedContractsDirectory,
    "src",
    "openapi.ts",
  );
  await mkdir(join(linkedContractsDirectory, "openapi"), { recursive: true });
  await mkdir(externalSourceDirectory, { recursive: true });
  await writeFile(linkedSnapshotPath, currentSnapshot, "utf8");
  await writeFile(
    join(externalSourceDirectory, "openapi.ts"),
    canonicalRuntimeWrapper,
    "utf8",
  );
  await symlink(
    externalSourceDirectory,
    join(linkedContractsDirectory, "src"),
    "dir",
  );
  const redirected = await runCheckerCli([
    "--bootstrap-candidate",
    linkedSnapshotPath,
    "--candidate-source",
    linkedSourcePath,
  ]);
  expect(redirected.exitCode).toBe(1);
  expect(redirected.stderr).toContain(
    "must be regular files in one physical contracts tree",
  );

  await writeFile(
    snapshotPath,
    serializeCanonicalJson({ openapi: "3.1.0", paths: {} }),
    "utf8",
  );
  const incompatible = await runCheckerCli([
    "--bootstrap-candidate",
    snapshotPath,
    "--candidate-source",
    sourcePath,
  ]);
  expect(incompatible.exitCode).toBe(1);
  expect(incompatible.stderr).toContain(
    "Public API compatibility check failed",
  );

  await writeFile(snapshotPath, currentSnapshot, "utf8");
  await writeFile(
    sourcePath,
    canonicalRuntimeWrapper.replace(
      "PUBLIC_API_OPENAPI_DOCUMENT = publicApiOpenApiDocumentJson",
      "PUBLIC_API_OPENAPI_DOCUMENT = {}",
    ),
    "utf8",
  );
  const unbound = await runCheckerCli([
    "--bootstrap-candidate",
    snapshotPath,
    "--candidate-source",
    sourcePath,
  ]);
  expect(unbound.exitCode).toBe(1);
  expect(unbound.stderr).toContain(
    "must be the trusted canonical JSON wrapper",
  );
});

test("normal and update CLI modes reject stale and redirected snapshots", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "mukuroji-public-api-update-"),
  );
  temporaryDirectories.push(directory);
  const isolatedRepository = join(directory, "repository");
  const isolatedCheckerPath = join(
    isolatedRepository,
    "scripts",
    "check-public-api-contract.ts",
  );
  const contractsDirectory = join(isolatedRepository, "contracts");
  const openapiDirectory = join(contractsDirectory, "openapi");
  const snapshotPath = join(openapiDirectory, "public-api-v1.json");
  const sourcePath = join(contractsDirectory, "src", "openapi.ts");
  await mkdir(join(isolatedRepository, "scripts"), { recursive: true });
  await mkdir(openapiDirectory, { recursive: true });
  await mkdir(join(contractsDirectory, "src"), { recursive: true });
  await writeFile(
    isolatedCheckerPath,
    await readFile(checkerPath, "utf8"),
    "utf8",
  );
  const currentSnapshot = serializeCanonicalJson(
    PUBLIC_API_OPENAPI_DOCUMENT,
  );
  const previousSnapshot = serializeCanonicalJson(createDocument());
  const inlineRuntimeSource =
    `export const PUBLIC_API_OPENAPI_DOCUMENT = ${currentSnapshot}`;
  await writeFile(sourcePath, inlineRuntimeSource, "utf8");
  await writeFile(snapshotPath, previousSnapshot, "utf8");
  const previousHardLink = join(openapiDirectory, "previous.json");
  await link(snapshotPath, previousHardLink);

  const updated = await runCheckerCli(
    ["--update"],
    isolatedCheckerPath,
    isolatedRepository,
  );
  expect(updated.exitCode).toBe(0);
  expect(await readFile(snapshotPath, "utf8")).toBe(currentSnapshot);
  expect(await readFile(previousHardLink, "utf8")).toBe(previousSnapshot);

  await writeFile(snapshotPath, previousSnapshot, "utf8");
  const stale = await runCheckerCli(
    [],
    isolatedCheckerPath,
    isolatedRepository,
  );
  expect(stale.exitCode).toBe(1);
  expect(stale.stderr).toContain("is stale");

  await writeFile(snapshotPath, currentSnapshot, "utf8");
  await writeFile(sourcePath, canonicalRuntimeWrapper, "utf8");
  const candidate = await runCheckerCli(
    [
      "--candidate",
      snapshotPath,
      "--candidate-source",
      sourcePath,
    ],
    isolatedCheckerPath,
    isolatedRepository,
  );
  expect(candidate.exitCode).toBe(0);
  expect(candidate.stdout).toContain(
    "remains compatible with the trusted base contract",
  );

  await writeFile(sourcePath, inlineRuntimeSource, "utf8");
  await rm(snapshotPath);
  const externalSnapshot = join(directory, "external-snapshot.json");
  await writeFile(externalSnapshot, previousSnapshot, "utf8");
  await symlink(externalSnapshot, snapshotPath, "file");
  const redirectedFile = await runCheckerCli(
    ["--update"],
    isolatedCheckerPath,
    isolatedRepository,
  );
  expect(redirectedFile.exitCode).toBe(1);
  expect(redirectedFile.stderr).toContain(
    "update target must be a regular file",
  );
  expect(await readFile(externalSnapshot, "utf8")).toBe(previousSnapshot);

  await rm(snapshotPath);
  await rm(openapiDirectory, { recursive: true });
  const externalDirectory = join(directory, "external-openapi");
  await mkdir(externalDirectory);
  await symlink(externalDirectory, openapiDirectory, "dir");
  const redirectedDirectory = await runCheckerCli(
    ["--update"],
    isolatedCheckerPath,
    isolatedRepository,
  );
  expect(redirectedDirectory.exitCode).toBe(1);
  expect(redirectedDirectory.stderr).toContain(
    "requires a physical repository openapi directory",
  );
  expect(
    await Bun.file(
      join(externalDirectory, "public-api-v1.json"),
    ).exists(),
  ).toBe(false);
});
