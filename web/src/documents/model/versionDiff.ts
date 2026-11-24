import type { DocumentBlock, DocumentDetail } from '@mukuroji/contracts'

/**
 * One block in a block-level comparison of two Document versions.
 */
export type DocumentBlockDiffEntry =
  | {
      /** The block exists in both versions with the same content and position. */
      kind: 'unchanged'
      /** Block in the newer version. */
      block: DocumentBlock
    }
  | {
      /** The block exists only in the newer version. */
      kind: 'added'
      /** Added block. */
      block: DocumentBlock
    }
  | {
      /** The block exists only in the older version. */
      kind: 'removed'
      /** Removed block. */
      block: DocumentBlock
    }
  | {
      /** The block exists in both versions and its content changed in place. */
      kind: 'changed'
      /** Block in the older version. */
      before: DocumentBlock
      /** Block in the newer version. */
      block: DocumentBlock
    }
  | {
      /** The block exists in both versions and moved to another position. */
      kind: 'moved'
      /** Block in the older version. */
      before: DocumentBlock
      /** Block in the newer version, shown at its new position. */
      block: DocumentBlock
      /** Whether the content also changed, so the older content must be shown too. */
      contentChanged: boolean
    }

/**
 * Counts of changed Whiteboard elements between two versions.
 */
export type WhiteboardDiffSummary = {
  /** Objects only in the newer version. */
  added: number
  /** Objects only in the older version. */
  removed: number
  /** Objects whose content changed. */
  changed: number
}

/**
 * Result of comparing two Document versions.
 */
export type DocumentVersionDiff = {
  /** Title of the older version when it differs from the newer one. */
  previousTitle?: string
  /** Block-level comparison for pages and templates, in the newer version's order. */
  blocks: DocumentBlockDiffEntry[]
  /** Element counts for Whiteboards; absent for other kinds. */
  whiteboard?: WhiteboardDiffSummary
  /** Whether anything differs between the two versions. */
  hasChanges: boolean
}

/**
 * Compares two Document snapshots block by block.
 *
 * Blocks are matched by their stable ID. Blocks kept in the same relative order
 * are reported as unchanged or changed in place, blocks that left that order as
 * moved at their new position, and the rest as added or removed.
 *
 * @param before - Older snapshot.
 * @param after - Newer snapshot.
 * @returns The comparison in the newer snapshot's order.
 */
export function diffDocumentVersions(
  before: DocumentDetail,
  after: DocumentDetail,
): DocumentVersionDiff {
  const previousTitle = before.title === after.title ? undefined : before.title
  const blocks = diffDocumentBlocks(readBlocks(before), readBlocks(after))
  const whiteboard = before.kind === 'whiteboard' || after.kind === 'whiteboard'
    ? diffWhiteboardObjects(before, after)
    : undefined
  const hasChanges = previousTitle !== undefined ||
    blocks.some((entry) => entry.kind !== 'unchanged') ||
    (whiteboard !== undefined && whiteboard.added + whiteboard.removed + whiteboard.changed > 0)
  return {
    ...(previousTitle === undefined ? {} : { previousTitle }),
    blocks,
    ...(whiteboard === undefined ? {} : { whiteboard }),
    hasChanges,
  }
}

/**
 * Compares two block lists by block ID.
 *
 * @param before - Blocks of the older version.
 * @param after - Blocks of the newer version.
 * @returns The comparison in the newer version's order, with removed blocks at their old position.
 */
export function diffDocumentBlocks(
  before: readonly DocumentBlock[],
  after: readonly DocumentBlock[],
): DocumentBlockDiffEntry[] {
  const beforeById = new Map(before.map((block) => [block.id, block]))
  const afterIds = new Set(after.map((block) => block.id))
  const stable = longestCommonIdSubsequence(
    before.map((block) => block.id),
    after.map((block) => block.id),
  )
  const entries: DocumentBlockDiffEntry[] = []
  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < before.length || afterIndex < after.length) {
    const previous = before[beforeIndex]
    if (previous !== undefined && !afterIds.has(previous.id)) {
      entries.push({ kind: 'removed', block: previous })
      beforeIndex += 1
      continue
    }
    if (previous !== undefined && !stable.has(previous.id)) {
      beforeIndex += 1
      continue
    }
    const next = after[afterIndex]
    if (next === undefined) {
      beforeIndex += 1
      continue
    }
    const matched = beforeById.get(next.id)
    if (matched === undefined) {
      entries.push({ kind: 'added', block: next })
    } else if (!stable.has(next.id)) {
      entries.push({ kind: 'moved', before: matched, block: next, contentChanged: !isSameBlock(matched, next) })
    } else {
      entries.push(
        isSameBlock(matched, next)
          ? { kind: 'unchanged', block: next }
          : { kind: 'changed', before: matched, block: next },
      )
      beforeIndex += 1
    }
    afterIndex += 1
  }
  return entries
}

/**
 * Reads the rich-text blocks of a snapshot.
 *
 * @param document - Document snapshot.
 * @returns Its blocks, or an empty list for kinds without blocks.
 */
function readBlocks(document: DocumentDetail): readonly DocumentBlock[] {
  return document.kind === 'page' || document.kind === 'template' ? document.blocks : []
}

/**
 * Counts added, removed, and changed Whiteboard objects.
 *
 * @param before - Older snapshot.
 * @param after - Newer snapshot.
 * @returns Element counts.
 */
function diffWhiteboardObjects(before: DocumentDetail, after: DocumentDetail): WhiteboardDiffSummary {
  const previous = new Map(
    (before.kind === 'whiteboard' ? before.whiteboard.objects : []).map((object) => [object.id, object]),
  )
  const next = after.kind === 'whiteboard' ? after.whiteboard.objects : []
  let added = 0
  let changed = 0
  for (const object of next) {
    const matched = previous.get(object.id)
    if (matched === undefined) added += 1
    else if (JSON.stringify(matched) !== JSON.stringify(object)) changed += 1
    previous.delete(object.id)
  }
  return { added, removed: previous.size, changed }
}

/**
 * Compares the content of two blocks with the same ID.
 *
 * @param left - First block.
 * @param right - Second block.
 * @returns Whether the blocks have the same content.
 */
function isSameBlock(left: DocumentBlock, right: DocumentBlock) {
  return stableStringify(left) === stableStringify(right)
}

/**
 * Serializes a JSON value with sorted object keys.
 *
 * @param value - JSON value.
 * @returns A key-order independent serialization.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Finds the IDs that keep their relative order between two lists.
 *
 * @param left - IDs in the older order.
 * @param right - IDs in the newer order.
 * @returns IDs on one longest common subsequence.
 */
function longestCommonIdSubsequence(left: readonly string[], right: readonly string[]): Set<string> {
  const width = right.length + 1
  const lengths = new Uint16Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = left[i] === right[j]
        ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
    }
  }
  const stable = new Set<string>()
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const leftId = left[i]
    if (leftId !== undefined && leftId === right[j]) {
      stable.add(leftId)
      i += 1
      j += 1
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      i += 1
    } else {
      j += 1
    }
  }
  return stable
}
