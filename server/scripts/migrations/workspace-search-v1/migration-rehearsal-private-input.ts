import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { types as nodeUtilTypes } from 'node:util'

/** Largest restricted rehearsal input accepted by the shared reader. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRIVATE_INPUT_MAX_BYTES =
  64 * 1_024 * 1_024

/** Exact owner-only permission bits required for restricted inputs. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRIVATE_INPUT_MODE = 0o600

/** Stable raw-value-free private-input failure classifications. */
export type WorkspaceSearchMigrationRehearsalPrivateInputErrorCode =
  | 'INVALID_PRIVATE_INPUT'
  | 'PRIVATE_INPUT_UNREADABLE'

/** Stable failure raised when a restricted input is unsafe or unreadable. */
export class WorkspaceSearchMigrationRehearsalPrivateInputError
  extends Error {
  /** Machine-readable failure containing no path or filesystem detail. */
  readonly code: WorkspaceSearchMigrationRehearsalPrivateInputErrorCode

  /**
   * Creates one raw-value-free restricted-input failure.
   *
   * @param code - Stable failure classification.
   */
  constructor(code: WorkspaceSearchMigrationRehearsalPrivateInputErrorCode) {
    super(code)
    this.name = 'WorkspaceSearchMigrationRehearsalPrivateInputError'
    this.code = code
  }
}

/** Stable descriptor identity compared across one complete private read. */
type WorkspaceSearchMigrationRehearsalPrivateInputIdentity = {
  /** Device identifier. */
  readonly device: bigint
  /** Inode identifier. */
  readonly inode: bigint
  /** Exact regular-file size. */
  readonly size: bigint
  /** Complete native permission and file-type mode. */
  readonly mode: bigint
  /** Owning user identifier. */
  readonly userId: bigint
  /** Owning group identifier. */
  readonly groupId: bigint
  /** Exact hard-link count. */
  readonly linkCount: bigint
  /** Nanosecond modification time. */
  readonly modifiedAtNanoseconds: bigint
  /** Nanosecond metadata-change time. */
  readonly changedAtNanoseconds: bigint
}

/** Maximum accepted local path length at the restricted-input boundary. */
const maximumPrivateInputPathLength = 4_096

/**
 * Reads one stable, owner-only, single-link regular rehearsal input.
 *
 * The final path component is never followed. The opened descriptor must be
 * owned by the effective user, have exact mode 0600 and one link, and retain
 * identical identity, ownership, permissions, size, mtime, and ctime through
 * the exact bounded read. A close failure rejects the input as well.
 *
 * @param path - Exact local restricted input path.
 * @param maximumBytes - Positive inclusive byte ceiling.
 * @returns Detached exact file bytes.
 */
export async function readWorkspaceSearchMigrationRehearsalPrivateInputFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const safePath = readPrivateInputPath(path)
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRIVATE_INPUT_MAX_BYTES
  ) return failPrivateInput('INVALID_PRIVATE_INPUT')
  const getUserId = process.getuid
  if (typeof getUserId !== 'function' || nodeUtilTypes.isProxy(getUserId)) {
    return failPrivateInput('INVALID_PRIVATE_INPUT')
  }
  let currentUserId: number
  try {
    currentUserId = Reflect.apply(getUserId, process, [])
  } catch {
    return failPrivateInput('INVALID_PRIVATE_INPUT')
  }
  if (!Number.isSafeInteger(currentUserId) || currentUserId < 0) {
    return failPrivateInput('INVALID_PRIVATE_INPUT')
  }
  const noFollowFlag: unknown = constants.O_NOFOLLOW
  if (
    typeof noFollowFlag !== 'number' ||
    !Number.isSafeInteger(noFollowFlag) ||
    noFollowFlag <= 0
  ) return failPrivateInput('INVALID_PRIVATE_INPUT')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      safePath,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag,
    )
  } catch {
    return failPrivateInput('PRIVATE_INPUT_UNREADABLE')
  }
  let bytes: Uint8Array | undefined
  let readFailure: unknown
  try {
    const initial = await handle.stat({ bigint: true })
    const identity = readPrivateInputIdentity(
      initial,
      currentUserId,
      maximumBytes,
    )
    const byteLength = Number(identity.size)
    const buffer = Buffer.alloc(byteLength)
    let offset = 0
    while (offset < byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        byteLength - offset,
        offset,
      )
      if (result.bytesRead <= 0) {
        return failPrivateInput('INVALID_PRIVATE_INPUT')
      }
      offset += result.bytesRead
    }
    const final = await handle.stat({ bigint: true })
    if (!samePrivateInputIdentity(identity, final, offset)) {
      return failPrivateInput('INVALID_PRIVATE_INPUT')
    }
    bytes = new Uint8Array(buffer)
  } catch (error: unknown) {
    readFailure = error
  }
  let closeFailed = false
  try {
    await handle.close()
  } catch {
    closeFailed = true
  }
  if (readFailure instanceof WorkspaceSearchMigrationRehearsalPrivateInputError) {
    throw readFailure
  }
  if (readFailure !== undefined || closeFailed || bytes === undefined) {
    return failPrivateInput('PRIVATE_INPUT_UNREADABLE')
  }
  return bytes
}

/** Requires one finite non-empty path without retaining caller objects. */
function readPrivateInputPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumPrivateInputPathLength ||
    value.includes('\0')
  ) return failPrivateInput('INVALID_PRIVATE_INPUT')
  return value
}

/** Reads and validates one descriptor's initial restricted identity. */
function readPrivateInputIdentity(
  value: BigIntStats,
  expectedUserId: number,
  maximumBytes: number,
): WorkspaceSearchMigrationRehearsalPrivateInputIdentity {
  if (
    !value.isFile() ||
    value.size <= 0n ||
    value.size > BigInt(maximumBytes) ||
    (value.mode & 0o7777n) !==
      BigInt(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRIVATE_INPUT_MODE) ||
    value.uid !== BigInt(expectedUserId) ||
    value.nlink !== 1n
  ) return failPrivateInput('INVALID_PRIVATE_INPUT')
  return Object.freeze({
    device: value.dev,
    inode: value.ino,
    size: value.size,
    mode: value.mode,
    userId: value.uid,
    groupId: value.gid,
    linkCount: value.nlink,
    modifiedAtNanoseconds: value.mtimeNs,
    changedAtNanoseconds: value.ctimeNs,
  })
}

/** Requires the descriptor identity and exact length to remain unchanged. */
function samePrivateInputIdentity(
  expected: WorkspaceSearchMigrationRehearsalPrivateInputIdentity,
  value: BigIntStats,
  bytesRead: number,
): boolean {
  return value.isFile() &&
    value.dev === expected.device &&
    value.ino === expected.inode &&
    value.size === expected.size &&
    value.mode === expected.mode &&
    value.uid === expected.userId &&
    value.gid === expected.groupId &&
    value.nlink === expected.linkCount &&
    value.mtimeNs === expected.modifiedAtNanoseconds &&
    value.ctimeNs === expected.changedAtNanoseconds &&
    value.size === BigInt(bytesRead)
}

/** Raises one stable private-input failure without exposing its path. */
function failPrivateInput(
  code: WorkspaceSearchMigrationRehearsalPrivateInputErrorCode,
): never {
  throw new WorkspaceSearchMigrationRehearsalPrivateInputError(code)
}
