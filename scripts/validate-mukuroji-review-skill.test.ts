import { afterEach, expect, test } from "bun:test";
import {
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
  referencesDirectory: string;
  repository: string;
  skillDirectory: string;
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
  await mkdir(agentsDirectory, { recursive: true });
  await mkdir(referencesDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---
name: mukuroji-review
description: Review a pinned Mukuroji change through focused perspectives.
---

# Mukuroji Review

- [Issue fit](references/issue-fit.md)
`,
  );
  await writeFile(
    join(agentsDirectory, "openai.yaml"),
    `interface:
  display_name: "Mukuroji Review"
  short_description: "Risk-based multi-agent code review"
  default_prompt: "Use $mukuroji-review to review this change."
`,
  );
  await writeFile(
    join(referencesDirectory, "issue-fit.md"),
    "# Intent fit review\n",
  );
  expect((await runProcess(["git", "init"], repository)).exitCode).toBe(0);
  expect((await runProcess(["git", "add", "."], repository)).exitCode).toBe(
    0,
  );

  return { referencesDirectory, repository, skillDirectory };
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
  const referencePath = join(
    fixture.referencesDirectory,
    "issue-fit.md",
  );
  const outsidePath = join(fixture.repository, "outside.md");
  await writeFile(outsidePath, "# Outside\n");
  await unlink(referencePath);
  await symlink(outsidePath, referencePath);
  expect(
    (await runProcess(["git", "add", "-A"], fixture.repository)).exitCode,
  ).toBe(0);

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
  expect(
    (await runProcess(["git", "add", "-A"], fixture.repository)).exitCode,
  ).toBe(0);

  const result = await runValidator(
    fixture.repository,
    fixture.skillDirectory,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "references/nested/orphan.md",
  );
});
