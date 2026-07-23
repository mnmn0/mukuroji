import { lstat, readdir, readFile } from "node:fs/promises";
import { normalize, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const skillDirectoryArgument = process.argv[2];
const skillDirectory =
  skillDirectoryArgument === undefined
    ? resolve(repositoryRoot, ".codex/skills/mukuroji-review")
    : resolve(skillDirectoryArgument);
const gitRootArgument = process.argv[3];
const gitRoot =
  gitRootArgument === undefined ? repositoryRoot : resolve(gitRootArgument);
const skillPath = resolve(skillDirectory, "SKILL.md");
const agentsDirectory = resolve(skillDirectory, "agents");
const agentMetadataPath = resolve(skillDirectory, "agents/openai.yaml");
const referencesDirectory = resolve(skillDirectory, "references");

/**
 * Requires a path to be a real directory rather than a symlink.
 *
 * @param path - Filesystem path to validate.
 * @param label - Human-readable source label for validation errors.
 */
async function requireDirectory(path: string, label: string): Promise<void> {
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw new TypeError(`${label} must be a non-symlink directory`);
  }
}

/**
 * Requires a path to be a regular file rather than a symlink.
 *
 * @param path - Filesystem path to validate.
 * @param label - Human-readable source label for validation errors.
 */
async function requireRegularFile(path: string, label: string): Promise<void> {
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new TypeError(`${label} must be a non-symlink regular file`);
  }
}

/**
 * Rejects symlinks and special filesystem entries anywhere in a Skill tree.
 *
 * @param directory - Directory whose descendants are validated.
 * @param label - Skill-relative directory label for validation errors.
 */
async function requireSafeTree(
  directory: string,
  label: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryLabel = `${label}/${entry.name}`;
    const entryPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError(`${entryLabel} must not be a symlink`);
    }
    if (entry.isDirectory()) {
      await requireSafeTree(entryPath, entryLabel);
      continue;
    }
    if (!entry.isFile()) {
      throw new TypeError(`${entryLabel} must be a regular file or directory`);
    }
    const entryStats = await lstat(entryPath);
    if ((entryStats.mode & 0o111) !== 0) {
      throw new TypeError(`${entryLabel} must not be executable`);
    }
  }
}

/**
 * Lists Markdown files recursively using Skill-relative paths.
 *
 * @param directory - Directory to enumerate.
 * @param relativeDirectory - Skill-relative directory name.
 * @returns Sorted Skill-relative Markdown paths.
 */
async function listMarkdownFiles(
  directory: string,
  relativeDirectory: string,
): Promise<string[]> {
  const markdownFiles: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      markdownFiles.push(
        ...(await listMarkdownFiles(entryPath, relativePath)),
      );
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      markdownFiles.push(relativePath);
    }
  }

  return markdownFiles.sort();
}

/**
 * Rejects non-regular Git modes such as symlinks, executables, and gitlinks.
 *
 * @param repository - Git worktree containing the Skill.
 * @param directory - Skill directory within the Git worktree.
 */
async function requireSafeGitModes(
  repository: string,
  directory: string,
): Promise<void> {
  const skillGitPath = relative(repository, directory).replaceAll("\\", "/");
  if (
    skillGitPath === "" ||
    skillGitPath.startsWith("../") ||
    skillGitPath === ".."
  ) {
    throw new TypeError("Skill directory must be inside the supplied Git worktree");
  }

  const gitProcess = Bun.spawn(
    [
      "git",
      "-C",
      repository,
      "ls-files",
      "--stage",
      "-z",
      "--",
      skillGitPath,
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(gitProcess.stdout).text(),
    new Response(gitProcess.stderr).text(),
    gitProcess.exited,
  ]);
  if (exitCode !== 0) {
    throw new TypeError(`Unable to inspect Skill Git modes: ${stderr.trim()}`);
  }

  const records = stdout.split("\0").filter((record) => record.length > 0);
  if (records.length === 0) {
    throw new TypeError("Skill directory has no tracked Git files");
  }

  for (const record of records) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) {
      throw new TypeError("Unexpected git ls-files output for Skill tree");
    }

    const metadata = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const mode = metadata.split(" ", 1)[0];
    if (mode !== "100644") {
      throw new TypeError(`${path} has disallowed Git mode ${mode}`);
    }
  }
}

/**
 * Requires an unknown YAML value to be a non-array object.
 *
 * @param value - Parsed YAML value to validate.
 * @param label - Human-readable source label for validation errors.
 * @returns The validated object.
 */
function requireObject(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a YAML mapping`);
  }

  return value;
}

/**
 * Requires an unknown YAML value to be an array.
 *
 * @param value - Parsed YAML value to validate.
 * @param label - Human-readable source label for validation errors.
 * @returns The validated array while preserving unknown item types.
 */
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a YAML sequence`);
  }

  return value;
}

/**
 * Reads a required string property from a validated object.
 *
 * @param value - Object containing the property.
 * @param property - Property name to read.
 * @param label - Human-readable source label for validation errors.
 * @returns The non-empty string property value.
 */
function requireString(
  value: object,
  property: string,
  label: string,
): string {
  const propertyValue: unknown = Reflect.get(value, property);
  if (typeof propertyValue !== "string" || propertyValue.trim().length === 0) {
    throw new TypeError(`${label}.${property} must be a non-empty string`);
  }

  return propertyValue;
}

/**
 * Reads a required boolean property from a validated object.
 *
 * @param value - Object containing the property.
 * @param property - Property name to read.
 * @param label - Human-readable source label for validation errors.
 * @returns The boolean property value.
 */
function requireBoolean(
  value: object,
  property: string,
  label: string,
): boolean {
  const propertyValue: unknown = Reflect.get(value, property);
  if (typeof propertyValue !== "boolean") {
    throw new TypeError(`${label}.${property} must be a boolean`);
  }

  return propertyValue;
}

/**
 * Rejects unexpected keys in a YAML mapping.
 *
 * @param value - Object whose keys are validated.
 * @param allowedKeys - Keys accepted by the schema.
 * @param label - Human-readable source label for validation errors.
 */
function requireOnlyKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new TypeError(
      `${label} has unexpected keys: ${unexpectedKeys.join(", ")}`,
    );
  }
}

/**
 * Splits a Markdown document into YAML frontmatter and body.
 *
 * @param markdown - Complete Markdown document.
 * @param label - Human-readable source label for validation errors.
 * @returns The YAML frontmatter and Markdown body.
 */
function extractFrontmatter(
  markdown: string,
  label: string,
): [string, string] {
  const opening = "---\n";
  const closing = "\n---\n";
  if (!markdown.startsWith(opening)) {
    throw new TypeError(`${label} must start with YAML frontmatter`);
  }

  const closingIndex = markdown.indexOf(closing, opening.length);
  if (closingIndex === -1) {
    throw new TypeError(`${label} has unterminated YAML frontmatter`);
  }

  return [
    markdown.slice(opening.length, closingIndex),
    markdown.slice(closingIndex + closing.length),
  ];
}

/**
 * Parses YAML while preserving an unknown trust boundary.
 *
 * @param yaml - YAML source text.
 * @param label - Human-readable source label for parse errors.
 * @returns The parsed YAML value.
 */
function parseYaml(yaml: string, label: string): unknown {
  try {
    const parsed: unknown = Bun.YAML.parse(yaml);
    return parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${label} is invalid YAML: ${message}`);
  }
}

/**
 * Ensures a referenced Markdown path stays inside the Skill directory.
 *
 * @param referencePath - Repository-relative path found in SKILL.md.
 * @returns The normalized path relative to the Skill directory.
 */
function normalizeReference(referencePath: string): string {
  const normalizedPath = normalize(referencePath);
  const absolutePath = resolve(skillDirectory, normalizedPath);
  const relativePath = relative(skillDirectory, absolutePath);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    !relativePath.startsWith(`references/`)
  ) {
    throw new TypeError(
      `SKILL.md contains an unsafe reference path: ${referencePath}`,
    );
  }

  return relativePath;
}

await requireDirectory(skillDirectory, "Skill directory");
await requireDirectory(agentsDirectory, "agents");
await requireDirectory(referencesDirectory, "references");
await requireSafeGitModes(gitRoot, skillDirectory);
await requireSafeTree(skillDirectory, ".");
await requireRegularFile(skillPath, "SKILL.md");
await requireRegularFile(agentMetadataPath, "agents/openai.yaml");

const skillMarkdown = await readFile(skillPath, "utf8");
const [skillFrontmatter, skillBody] = extractFrontmatter(
  skillMarkdown,
  "SKILL.md",
);
const skillMetadata = requireObject(
  parseYaml(skillFrontmatter, "SKILL.md frontmatter"),
  "SKILL.md frontmatter",
);
requireOnlyKeys(
  skillMetadata,
  new Set(["name", "description", "license", "allowed-tools", "metadata"]),
  "SKILL.md frontmatter",
);
const skillName = requireString(skillMetadata, "name", "SKILL.md frontmatter");
const skillDescription = requireString(
  skillMetadata,
  "description",
  "SKILL.md frontmatter",
);

if (skillName !== "mukuroji-review") {
  throw new TypeError("SKILL.md name must match the Skill directory");
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
  throw new TypeError("SKILL.md name must use lowercase hyphen-case");
}
if (skillName.length > 64) {
  throw new TypeError("SKILL.md name must not exceed 64 characters");
}
if (skillDescription.length > 1024) {
  throw new TypeError("SKILL.md description must not exceed 1024 characters");
}
if (skillDescription.includes("<") || skillDescription.includes(">")) {
  throw new TypeError("SKILL.md description must not contain angle brackets");
}

const agentMetadataSource = await readFile(agentMetadataPath, "utf8");
const agentMetadata = requireObject(
  parseYaml(agentMetadataSource, "agents/openai.yaml"),
  "agents/openai.yaml",
);
requireOnlyKeys(
  agentMetadata,
  new Set(["interface", "dependencies", "policy"]),
  "agents/openai.yaml",
);
const interfaceMetadata = requireObject(
  Reflect.get(agentMetadata, "interface"),
  "agents/openai.yaml.interface",
);
requireOnlyKeys(
  interfaceMetadata,
  new Set([
    "display_name",
    "short_description",
    "icon_small",
    "icon_large",
    "brand_color",
    "default_prompt",
  ]),
  "agents/openai.yaml.interface",
);
requireString(
  interfaceMetadata,
  "display_name",
  "agents/openai.yaml.interface",
);
const shortDescription = requireString(
  interfaceMetadata,
  "short_description",
  "agents/openai.yaml.interface",
);
const defaultPrompt = requireString(
  interfaceMetadata,
  "default_prompt",
  "agents/openai.yaml.interface",
);
if (shortDescription.length < 25 || shortDescription.length > 64) {
  throw new TypeError(
    "agents/openai.yaml.interface.short_description must be 25-64 characters",
  );
}
if (!defaultPrompt.includes(`$${skillName}`)) {
  throw new TypeError(
    "agents/openai.yaml.interface.default_prompt must mention the Skill name",
  );
}

const dependenciesValue: unknown = Reflect.get(
  agentMetadata,
  "dependencies",
);
if (dependenciesValue !== undefined) {
  const dependenciesMetadata = requireObject(
    dependenciesValue,
    "agents/openai.yaml.dependencies",
  );
  requireOnlyKeys(
    dependenciesMetadata,
    new Set(["tools"]),
    "agents/openai.yaml.dependencies",
  );
  const tools = requireArray(
    Reflect.get(dependenciesMetadata, "tools"),
    "agents/openai.yaml.dependencies.tools",
  );
  if (tools.length === 0) {
    throw new TypeError(
      "agents/openai.yaml.dependencies.tools must not be empty",
    );
  }

  for (const [index, toolValue] of tools.entries()) {
    const toolLabel = `agents/openai.yaml.dependencies.tools[${index}]`;
    const tool = requireObject(toolValue, toolLabel);
    requireOnlyKeys(
      tool,
      new Set([
        "type",
        "value",
        "description",
        "transport",
        "url",
      ]),
      toolLabel,
    );
    const toolType = requireString(tool, "type", toolLabel);
    if (toolType !== "mcp") {
      throw new TypeError(`${toolLabel}.type must be mcp`);
    }
    requireString(tool, "value", toolLabel);
    requireString(tool, "description", toolLabel);
    requireString(tool, "transport", toolLabel);
    requireString(tool, "url", toolLabel);
  }
}

const policyValue: unknown = Reflect.get(agentMetadata, "policy");
if (policyValue !== undefined) {
  const policyMetadata = requireObject(
    policyValue,
    "agents/openai.yaml.policy",
  );
  requireOnlyKeys(
    policyMetadata,
    new Set(["allow_implicit_invocation"]),
    "agents/openai.yaml.policy",
  );
  requireBoolean(
    policyMetadata,
    "allow_implicit_invocation",
    "agents/openai.yaml.policy",
  );
}

const linkedReferences = new Set<string>();
const referencePattern = /\]\((references\/[^)#?]+\.md)\)/gu;
for (const match of skillBody.matchAll(referencePattern)) {
  const referencePath = match[1];
  if (referencePath === undefined) {
    continue;
  }

  const normalizedReference = normalizeReference(referencePath);
  await requireRegularFile(
    resolve(skillDirectory, normalizedReference),
    normalizedReference,
  );
  linkedReferences.add(normalizedReference);
}

const referenceFiles = await listMarkdownFiles(
  referencesDirectory,
  "references",
);
const unlinkedReferences = referenceFiles.filter(
  (referencePath) => !linkedReferences.has(referencePath),
);

if (linkedReferences.size === 0) {
  throw new TypeError("SKILL.md must link at least one perspective reference");
}
if (unlinkedReferences.length > 0) {
  throw new TypeError(
    `SKILL.md does not link references: ${unlinkedReferences.join(", ")}`,
  );
}

console.log(
  `Validated ${skillName}: metadata and ${referenceFiles.length} references`,
);
