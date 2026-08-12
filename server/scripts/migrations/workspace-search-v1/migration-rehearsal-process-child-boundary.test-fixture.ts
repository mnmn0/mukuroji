import assert from 'node:assert/strict'
import {
  spawnWorkspaceSearchMigrationRehearsalControlChild,
} from './migration-rehearsal-process-cli'

/** Absolute path used to start this fixture in a clean Bun process. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_CHILD_BOUNDARY_WORKER_PATH =
  import.meta.path

/**
 * Collects one finite process stream without decoding private content.
 *
 * @param stream - Isolated process byte stream.
 * @returns Exact observed byte count.
 */
async function countProcessBytes(
  stream: AsyncIterable<Uint8Array>,
): Promise<number> {
  let byteLength = 0
  for await (const chunk of stream) byteLength += chunk.byteLength
  return byteLength
}

/**
 * Verifies the real child-process descriptor mapping in a short-lived runtime.
 *
 * @returns A Promise that resolves after every pipe and the child exit settle.
 */
async function verifyChildProcessBoundary(): Promise<void> {
  const port = spawnWorkspaceSearchMigrationRehearsalControlChild([
    '--invalid-one',
    'value-one',
    '--invalid-two',
    'value-two',
    '--invalid-three',
    'value-three',
    '--invalid-four',
    'value-four',
    '--invalid-five',
    'value-five',
    '--',
    'plan',
  ])
  const [stdoutBytes, protocolBytes, exit] = await Promise.all([
    countProcessBytes(port.stdout),
    countProcessBytes(port.stderr),
    port.exited,
  ])
  assert.equal(stdoutBytes, 0)
  assert.equal(protocolBytes, 0)
  assert.deepEqual(exit, { kind: 'exit-code', exitCode: 2 })
}

if (import.meta.main) await verifyChildProcessBoundary()
