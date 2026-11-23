/** One file stored in a ZIP archive. */
export type ZipEntry = {
  /** Path inside the archive. */
  name: string
  /** File bytes. */
  data: Uint8Array
}

/** Limits that keep a hostile archive from exhausting memory. */
export type ZipReadLimits = {
  /** Most entries read from the archive. */
  maxEntries: number
  /** Largest uncompressed size of one entry, in bytes. */
  maxEntryBytes: number
  /** Largest uncompressed size of all entries read, in bytes. */
  maxTotalBytes: number
}

/** Error for an archive that this reader does not accept. */
export class ZipArchiveError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Explanation of the rejected input.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ZipArchiveError'
  }
}

const endOfCentralDirectorySignature = 0x06054b50
const centralDirectorySignature = 0x02014b50
const localFileSignature = 0x04034b50

/**
 * Reads the entries of a ZIP archive that the caller wants.
 *
 * Only stored and deflated entries are read. ZIP64, encrypted, and split archives are rejected,
 * and every entry's uncompressed size is checked against the limits while it is inflated.
 *
 * @param bytes - Archive bytes.
 * @param limits - Size and count limits.
 * @param wanted - Chooses which entry names to read; every entry when left out.
 * @returns Entry bytes by name.
 * @throws ZipArchiveError when the archive is invalid or exceeds a limit.
 */
export async function readZipArchive(
  bytes: Uint8Array,
  limits: ZipReadLimits,
  wanted: (name: string) => boolean = () => true,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEndOfCentralDirectory(view)
  const entryCount = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ZipArchiveError('Split archives are not supported.')
  }
  if (entryCount > limits.maxEntries) throw new ZipArchiveError('The archive has too many entries.')
  if (directoryOffset + directorySize > end) throw new ZipArchiveError('The archive directory is invalid.')
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  let offset = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== centralDirectorySignature) {
      throw new ZipArchiveError('The archive directory is invalid.')
    }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const expectedCrc = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (!wanted(name) || name.endsWith('/')) continue
    if (flags & 0x1) throw new ZipArchiveError('Encrypted archives are not supported.')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipArchiveError('ZIP64 archives are not supported.')
    }
    if (uncompressedSize > limits.maxEntryBytes) throw new ZipArchiveError(`"${name}" is too large.`)
    totalBytes += uncompressedSize
    if (totalBytes > limits.maxTotalBytes) throw new ZipArchiveError('The archive is too large.')
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== localFileSignature) {
      throw new ZipArchiveError(`"${name}" is invalid.`)
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > bytes.byteLength) throw new ZipArchiveError(`"${name}" is truncated.`)
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    let data: Uint8Array
    if (method === 0) {
      data = compressed
    } else if (method === 8) {
      data = await inflateRaw(compressed, uncompressedSize)
    } else {
      throw new ZipArchiveError(`"${name}" uses an unsupported compression method.`)
    }
    if (data.byteLength !== uncompressedSize) throw new ZipArchiveError(`"${name}" has the wrong size.`)
    if (crc32(data) !== expectedCrc) throw new ZipArchiveError(`"${name}" is corrupted.`)
    files.set(name, data)
  }
  return files
}

/**
 * Builds a ZIP archive whose entries are stored without compression.
 *
 * @param entries - Files in archive order.
 * @param modifiedAt - Modification time written for every entry.
 * @returns Archive bytes.
 */
export function createZipArchive(entries: readonly ZipEntry[], modifiedAt = new Date()): Uint8Array {
  const encoder = new TextEncoder()
  const time = (modifiedAt.getHours() << 11) | (modifiedAt.getMinutes() << 5) | Math.floor(modifiedAt.getSeconds() / 2)
  const date = ((Math.max(1980, modifiedAt.getFullYear()) - 1980) << 9) |
    ((modifiedAt.getMonth() + 1) << 5) | modifiedAt.getDate()
  const locals: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + name.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, localFileSignature, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, entry.data.byteLength, true)
    localView.setUint32(22, entry.data.byteLength, true)
    localView.setUint16(26, name.byteLength, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, centralDirectorySignature, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(12, time, true)
    centralView.setUint16(14, date, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, entry.data.byteLength, true)
    centralView.setUint32(24, entry.data.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local, entry.data)
    directory.push(central)
    offset += local.byteLength + entry.data.byteLength
  }
  const directorySize = directory.reduce((size, part) => size + part.byteLength, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, endOfCentralDirectorySignature, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, directorySize, true)
  endView.setUint32(16, offset, true)
  return concatBytes([...locals, ...directory, end])
}

/**
 * Finds the end-of-central-directory record.
 *
 * @param view - Archive bytes.
 * @returns Offset of the record.
 */
function findEndOfCentralDirectory(view: DataView) {
  const lowest = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let offset = view.byteLength - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === endOfCentralDirectorySignature) return offset
  }
  throw new ZipArchiveError('The file is not a ZIP archive.')
}

/**
 * Inflates raw DEFLATE data, stopping once it grows past its declared size.
 *
 * @param data - Compressed bytes.
 * @param expectedBytes - Declared uncompressed size.
 * @returns Inflated bytes.
 */
async function inflateRaw(data: Uint8Array, expectedBytes: number) {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > expectedBytes) {
        await reader.cancel()
        throw new ZipArchiveError('An archive entry is larger than its declared size.')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ZipArchiveError) throw error
    throw new ZipArchiveError('An archive entry could not be decompressed.')
  }
  return concatBytes(chunks)
}

/**
 * Joins byte arrays.
 *
 * @param parts - Parts in order.
 * @returns One array.
 */
function concatBytes(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

/** CRC-32 lookup table. */
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

/**
 * Computes the CRC-32 that ZIP stores for an entry.
 *
 * @param data - Entry bytes.
 * @returns Unsigned checksum.
 */
function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
