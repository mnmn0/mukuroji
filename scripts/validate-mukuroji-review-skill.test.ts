import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const validatorPath = resolve(
  import.meta.dir,
  "validate-mukuroji-review-skill.ts",
);
const temporaryDirectories: string[] = [];

/**
 * Runs a process and captures its complete result.
 *
 * @param command - Executable and arguments to run.
 * @param workingDirectory - Directory in which the process runs.
 * @returns The exit code and captured output.
 */
async function runProcess(
  command: string[],
  workingDirectory: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(command, {
    cwd: workingDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stderr, stdout };
}

/**
 * Creates and stages a minimal valid Skill in a temporary Git repository.
 *
 * @returns Paths to the temporary repository, Skill, and reference directory.
 */
async function createValidFixture(): Promise<{
  agentMetadataPath: string;
  referencePath: string;
  referencesDirectory: string;
  repository: string;
  skillDirectory: string;
  skillPath: string;
}> {
  const repository = await mkdtemp(
    join(tmpdir(), "mukuroji-review-validator-"),
  );
  temporaryDirectories.push(repository);
  const skillDirectory = join(
    repository,
    ".codex/skills/mukuroji-review",
  );
  const agentsDirectory = join(skillDirectory, "agents");
  const referencesDirectory = join(skillDirectory, "references");
  const skillPath = join(skillDirectory, "SKILL.md");
  const agentMetadataPath = join(agentsDirectory, "openai.yaml");
  const referencePath = join(referencesDirectory, "issue-fit.md");
  await mkdir(agentsDirectory, { recursive: true });
  await mkdir(referencesDirectory, { recursive: true });
  await writeFile(
    skillPath,
    `---
name: mukuroji-review
description: Review a pinned Mukuroji change through focused perspectives.
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await writeFile(
    agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
`,
  );
  await writeFile(
    referencePath,
    "# Intent fit review\n",
  );
  expect((await runProcess(["git", "init"], repository)).exitCode).toBe(0);
  expect((await runProcess(["git", "add", "."], repository)).exitCode).toBe(
    0,
  );

  return {
    agentMetadataPath,
    referencePath,
    referencesDirectory,
    repository,
    skillDirectory,
    skillPath,
  };
}

/**
 * Stages every fixture change and requires Git to accept it.
 *
 * @param repository - Fixture Git repository to update.
 */
async function stageFixture(repository: string): Promise<void> {
  expect(
    (await runProcess(["git", "add", "-A"], repository)).exitCode,
  ).toBe(0);
}

/**
 * Runs the validator against a prepared fixture.
 *
 * @param repository - Fixture Git repository.
 * @param skillDirectory - Fixture Skill directory.
 * @returns The validator process result.
 */
async function runValidator(
  repository: string,
  skillDirectory: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return runProcess(
    [process.execPath, validatorPath, skillDirectory, repository],
    repository,
  );
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("accepts a valid Skill tree", async () => {
  const fixture = await createValidFixture();
  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Validated mukuroji-review");
});

test("rejects a symlinked reference", async () => {
  const fixture = await createValidFixture();
  const outsidePath = join(fixture.repository, "outside.md");
  await writeFile(outsidePath, "# Outside\n");
  await unlink(fixture.referencePath);
  await symlink(outsidePath, fixture.referencePath);
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("disallowed Git mode 120000");
});

test("rejects an unlinked nested reference", async () => {
  const fixture = await createValidFixture();
  const nestedDirectory = join(fixture.referencesDirectory, "nested");
  await mkdir(nestedDirectory);
  await writeFile(join(nestedDirectory, "orphan.md"), "# Orphan\n");
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "references/nested/orphan.md",
  );
});

test("rejects an executable Skill file", async () => {
  const fixture = await createValidFixture();
  await chmod(fixture.referencePath, 0o755);
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("disallowed Git mode 100755");
});

test("rejects a gitlink inside the Skill tree", async () => {
  const fixture = await createValidFixture();
  const gitlinkPath =
    ".codex/skills/mukuroji-review/references/gitlink";
  const gitlinkOid = "0123456789abcdef0123456789abcdef01234567";
  const updateResult = await runProcess(
    [
      "git",
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlinkOid},${gitlinkPath}`,
    ],
    fixture.repository,
  );
  expect(updateResult.exitCode).toBe(0);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("disallowed Git mode 160000");
});

test("rejects SKILL.md without frontmatter", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    "# Mukuroji Review\n\n- [Issue fit](references/issue-fit.md)\n",
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("must start with YAML frontmatter");
});

test("rejects missing required Skill metadata", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    `---
name: mukuroji-review
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "SKILL.md frontmatter.description must be a non-empty string",
  );
});

test("rejects a Skill name that mismatches the directory", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    `---
name: another-review
description: Review a pinned Mukuroji change through focused perspectives.
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "SKILL.md name must match the Skill directory",
  );
});

test("rejects an overlong Skill description", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    `---
name: mukuroji-review
description: ${"a".repeat(1025)}
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "SKILL.md description must not exceed 1024 characters",
  );
});

test("rejects angle brackets in the Skill description", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    `---
name: mukuroji-review
description: Review <untrusted> changes.
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "SKILL.md description must not contain angle brackets",
  );
});

test("rejects an invalid agent short description", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Too short"
  default_prompt: "Use $mukuroji-review to review this change."
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "short_description must be 25-64 characters",
  );
});

test("rejects an agent prompt without the Skill name", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Review this change."
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "default_prompt must mention the Skill name",
  );
});

test("accepts structurally valid optional agent metadata", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
dependencies:
  tools:
    - type: "mcp"
      value: "github"
      description: "GitHub MCP server"
      transport: "streamable_http"
      url: "https://example.com/mcp/"
policy:
  allow_implicit_invocation: false
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).toBe(0);
});

test("rejects malformed agent dependencies", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
dependencies: []
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "agents/openai.yaml.dependencies must be a YAML mapping",
  );
});

test("rejects unsupported agent dependency types", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
dependencies:
  tools:
    - type: "http"
      value: "example"
      description: "Unsupported dependency"
      transport: "streamable_http"
      url: "https://example.com/mcp/"
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "agents/openai.yaml.dependencies.tools[0].type must be mcp",
  );
});

test("rejects malformed agent policy", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.agentMetadataPath,
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
policy:
  allow_implicit_invocation: "false"
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "agents/openai.yaml.policy.allow_implicit_invocation must be a boolean",
  );
});

test("rejects a Skill without perspective references", async () => {
  const fixture = await createValidFixture();
  await writeFile(
    fixture.skillPath,
    `---
name: mukuroji-review
description: Review a pinned Mukuroji change through focused perspectives.
---

# Mukuroji Review
`,
  );
  await stageFixture(fixture.repository);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "SKILL.md must link at least one perspective reference",
  );
});
