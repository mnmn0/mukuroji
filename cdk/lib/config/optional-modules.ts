/** CDK context key that lists the optional modules a deployment creates. */
export const OPTIONAL_MODULES_CONTEXT_KEY = 'mukuroji:optionalModules';

/** Names accepted in the optional-module context list, in documentation order. */
export const OPTIONAL_MODULE_NAMES = [
  'restoreDrill',
  'connectors',
  'requestEmail',
] as const;

/** Name of one module that a deployment creates only on request. */
export type OptionalModuleName = typeof OPTIONAL_MODULE_NAMES[number];

/**
 * Optional modules a deployment creates. A module that is `false` contributes no
 * resources, outputs, or runtime wiring to the stack.
 */
export type OptionalModules = Readonly<{
  /** Scheduled isolated restore drill with its Object Lock evidence bucket and keys. */
  readonly restoreDrill: boolean;
  /** External connector sync and poll workers, their queues, and the runtime secret. */
  readonly connectors: boolean;
  /** Request email ingestion Lambda that an external mail relay invokes. */
  readonly requestEmail: boolean;
}>;

/** Optional-module selection used when the deployment names none. */
export const NO_OPTIONAL_MODULES: OptionalModules = {
  restoreDrill: false,
  connectors: false,
  requestEmail: false,
};

/** Optional-module selection that creates every module, for full-coverage synthesis. */
export const ALL_OPTIONAL_MODULES: OptionalModules = {
  restoreDrill: true,
  connectors: true,
  requestEmail: true,
};

/**
 * Narrows a context entry to a known optional-module name.
 *
 * @param value - One entry from the context list.
 * @returns Whether the entry names a known module.
 */
function isOptionalModuleName(value: string): value is OptionalModuleName {
  return OPTIONAL_MODULE_NAMES.some((name) => name === value);
}

/**
 * Splits the context value into module-name entries.
 *
 * @param value - Raw context value from `cdk.json` or `--context`.
 * @returns Trimmed, non-empty entries.
 */
function readContextEntries(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const rawEntries = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value)
      ? value
      : undefined;
  if (rawEntries === undefined) {
    throw new Error(
      `${OPTIONAL_MODULES_CONTEXT_KEY} must be a comma-separated string or a list of module names.`,
    );
  }
  return rawEntries.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`${OPTIONAL_MODULES_CONTEXT_KEY} entries must be module names.`);
    }
    return entry.trim();
  }).filter((entry) => entry.length > 0);
}

/**
 * Parses the optional-module selection from CDK context.
 *
 * Omitting the context, or passing an empty string or `none`, creates no optional
 * module. Unknown names fail synthesis so a typo cannot silently drop a module.
 *
 * @param value - Raw context value from `cdk.json` or `--context`.
 * @returns The modules the deployment creates.
 */
export function parseOptionalModules(value: unknown): OptionalModules {
  const entries = readContextEntries(value);
  if (entries.length === 1 && entries[0] === 'none') return NO_OPTIONAL_MODULES;
  const selected = new Set<OptionalModuleName>();
  for (const entry of entries) {
    if (!isOptionalModuleName(entry)) {
      throw new Error(
        `Unknown optional module "${entry}" in ${OPTIONAL_MODULES_CONTEXT_KEY}. ` +
        `Use any of: ${OPTIONAL_MODULE_NAMES.join(', ')}.`,
      );
    }
    selected.add(entry);
  }
  return {
    restoreDrill: selected.has('restoreDrill'),
    connectors: selected.has('connectors'),
    requestEmail: selected.has('requestEmail'),
  };
}
