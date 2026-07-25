import { createHash } from 'node:crypto'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const canonicalNumberPattern =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u

/**
 * Stable failure raised when DynamoDB attribute evidence is not canonical.
 */
export class DynamoDbAttributeCodecError extends Error {
  /** Secret-free machine-readable failure code. */
  readonly code = 'INVALID_DYNAMODB_ATTRIBUTE'

  /**
   * Creates a raw-value-free codec failure.
   */
  constructor() {
    super('INVALID_DYNAMODB_ATTRIBUTE')
    this.name = 'DynamoDbAttributeCodecError'
  }
}

/**
 * JSON-safe tagged string attribute.
 */
export type EncodedStringAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'S'
  /** Exact string value. */
  readonly value: string
}

/**
 * JSON-safe tagged number attribute.
 */
export type EncodedNumberAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'N'
  /** Exact DynamoDB number spelling. */
  readonly value: string
}

/**
 * JSON-safe tagged binary attribute.
 */
export type EncodedBinaryAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'B'
  /** Canonical padded base64 bytes. */
  readonly value: string
}

/**
 * JSON-safe tagged string-set attribute.
 */
export type EncodedStringSetAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'SS'
  /** UTF-8 ordinal sorted set members. */
  readonly value: readonly string[]
}

/**
 * JSON-safe tagged number-set attribute.
 */
export type EncodedNumberSetAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'NS'
  /** UTF-8 ordinal sorted exact number spellings. */
  readonly value: readonly string[]
}

/**
 * JSON-safe tagged binary-set attribute.
 */
export type EncodedBinarySetAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'BS'
  /** Byte-ordinal sorted canonical padded base64 members. */
  readonly value: readonly string[]
}

/**
 * JSON-safe tagged map attribute.
 */
export type EncodedMapAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'M'
  /** Attribute-name-sorted nested attributes. */
  readonly value: EncodedAttributeMap
}

/**
 * JSON-safe tagged list attribute.
 */
export type EncodedListAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'L'
  /** Ordered nested attribute values. */
  readonly value: readonly EncodedAttributeValue[]
}

/**
 * JSON-safe tagged null attribute.
 */
export type EncodedNullAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'NULL'
}

/**
 * JSON-safe tagged Boolean attribute.
 */
export type EncodedBooleanAttribute = {
  /** DynamoDB attribute tag. */
  readonly type: 'BOOL'
  /** Exact Boolean value. */
  readonly value: boolean
}

/**
 * Strict JSON-safe representation of every supported DynamoDB AttributeValue.
 */
export type EncodedAttributeValue =
  | EncodedBinaryAttribute
  | EncodedBinarySetAttribute
  | EncodedBooleanAttribute
  | EncodedListAttribute
  | EncodedMapAttribute
  | EncodedNullAttribute
  | EncodedNumberAttribute
  | EncodedNumberSetAttribute
  | EncodedStringAttribute
  | EncodedStringSetAttribute

/**
 * Strict JSON-safe DynamoDB attribute map.
 */
export type EncodedAttributeMap = Readonly<Record<string, EncodedAttributeValue>>

/**
 * Encodes one DynamoDB AttributeValue without losing binary or number spelling.
 *
 * Set members are sorted because DynamoDB sets have no observable order.
 *
 * @param value - Raw low-level DynamoDB attribute.
 * @returns Strict tagged JSON-safe representation.
 */
export function encodeAttributeValue(value: AttributeValue): EncodedAttributeValue {
  return encodeUnknownAttributeValue(value)
}

/**
 * Decodes and validates one tagged JSON-safe DynamoDB attribute.
 *
 * @param value - Untrusted tagged representation.
 * @returns Raw low-level DynamoDB attribute.
 */
export function decodeAttributeValue(value: unknown): AttributeValue {
  const record = requireRecord(value)
  const keys = Object.keys(record)
  const type = record.type

  if (type === 'NULL') {
    requireExactKeys(keys, ['type'])
    return { NULL: true }
  }

  requireExactKeys(keys, ['type', 'value'])

  if (type === 'S') {
    return { S: requireString(record.value) }
  }
  if (type === 'N') {
    return { N: requireNumberString(record.value) }
  }
  if (type === 'B') {
    return { B: decodeCanonicalBase64(record.value) }
  }
  if (type === 'SS') {
    return { SS: decodeStringSet(record.value) }
  }
  if (type === 'NS') {
    return { NS: decodeNumberSet(record.value) }
  }
  if (type === 'BS') {
    return { BS: decodeBinarySet(record.value) }
  }
  if (type === 'M') {
    return { M: decodeAttributeMap(record.value) }
  }
  if (type === 'L') {
    return { L: decodeAttributeList(record.value) }
  }
  if (type === 'BOOL') {
    return { BOOL: requireBoolean(record.value) }
  }

  return failCodec()
}

/**
 * Encodes an item or key map with stable attribute-name ordering.
 *
 * @param value - Raw low-level DynamoDB item or key.
 * @returns Strict tagged JSON-safe attribute map.
 */
export function encodeAttributeMap(
  value: Readonly<Record<string, AttributeValue>>,
): EncodedAttributeMap {
  const encoded: Record<string, EncodedAttributeValue> = {}

  for (const name of Object.keys(value).sort(compareUtf8Ordinal)) {
    requireAttributeName(name)
    const attribute = value[name]
    if (!attribute) return failCodec()
    defineOwnProperty(encoded, name, encodeAttributeValue(attribute))
  }

  return encoded
}

/**
 * Decodes an untrusted tagged item or key map.
 *
 * @param value - Untrusted JSON-safe attribute map.
 * @returns Raw low-level DynamoDB item or key.
 */
export function decodeAttributeMap(value: unknown): Record<string, AttributeValue> {
  const record = requireRecord(value)
  const decoded: Record<string, AttributeValue> = {}

  for (const name of Object.keys(record).sort(compareUtf8Ordinal)) {
    requireAttributeName(name)
    defineOwnProperty(decoded, name, decodeAttributeValue(record[name]))
  }

  return decoded
}

/**
 * Serializes an item or key into its unique canonical JSON representation.
 *
 * @param value - Raw low-level DynamoDB item or key.
 * @returns Canonical UTF-8 JSON text without a trailing newline.
 */
export function serializeCanonicalAttributeMap(
  value: Readonly<Record<string, AttributeValue>>,
): string {
  return JSON.stringify(encodeAttributeMap(value))
}

/**
 * Parses canonical attribute-map JSON and rejects non-canonical or tampered text.
 *
 * @param text - Exact canonical JSON text.
 * @returns Raw low-level DynamoDB item or key.
 */
export function parseCanonicalAttributeMap(text: string): Record<string, AttributeValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failCodec()
  }

  const decoded = decodeAttributeMap(parsed)
  if (serializeCanonicalAttributeMap(decoded) !== text) return failCodec()
  return decoded
}

/**
 * Creates a lowercase SHA-256 digest of the exact canonical attribute-map bytes.
 *
 * @param value - Raw low-level DynamoDB item or key.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function createAttributeMapDigest(
  value: Readonly<Record<string, AttributeValue>>,
): string {
  return createHash('sha256')
    .update(serializeCanonicalAttributeMap(value), 'utf8')
    .digest('hex')
}

/**
 * Converts a raw AttributeValue map to the native values used by source mappers.
 *
 * Number values must be finite, and integral values must be safe JavaScript
 * integers. Larger exact integers stay available through the lossless codec but
 * are rejected at this mapper boundary.
 *
 * @param value - Raw low-level DynamoDB item.
 * @returns Native record containing strings, numbers, bytes, sets, lists, and maps.
 */
export function decodeAttributeMapToNativeRecord(
  value: Readonly<Record<string, AttributeValue>>,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}

  for (const name of Object.keys(value)) {
    const attribute = value[name]
    if (!attribute) return failCodec()
    defineOwnProperty(decoded, name, decodeAttributeValueToNative(attribute))
  }

  return decoded
}

/**
 * Validates and encodes one unknown low-level attribute.
 *
 * @param value - Candidate AttributeValue.
 * @returns Strict tagged representation.
 */
function encodeUnknownAttributeValue(value: unknown): EncodedAttributeValue {
  const record = requireRecord(value)
  const keys = Object.keys(record)
  if (keys.length !== 1) return failCodec()
  const tag = keys[0]

  if (tag === 'S') {
    return { type: 'S', value: requireString(record.S) }
  }
  if (tag === 'N') {
    return { type: 'N', value: requireNumberString(record.N) }
  }
  if (tag === 'B') {
    return { type: 'B', value: encodeBinary(record.B) }
  }
  if (tag === 'SS') {
    return {
      type: 'SS',
      value: requireUniqueStringArray(record.SS).sort(compareUtf8Ordinal),
    }
  }
  if (tag === 'NS') {
    return {
      type: 'NS',
      value: requireUniqueNumberStringArray(record.NS).sort(compareUtf8Ordinal),
    }
  }
  if (tag === 'BS') {
    const binaries = requireUniqueBinaryArray(record.BS)
      .sort(compareBytes)
      .map(encodeBinary)
    return { type: 'BS', value: binaries }
  }
  if (tag === 'M') {
    return { type: 'M', value: encodeUnknownAttributeMap(record.M) }
  }
  if (tag === 'L') {
    return {
      type: 'L',
      value: requireArray(record.L).map(encodeUnknownAttributeValue),
    }
  }
  if (tag === 'NULL') {
    if (record.NULL !== true) return failCodec()
    return { type: 'NULL' }
  }
  if (tag === 'BOOL') {
    return { type: 'BOOL', value: requireBoolean(record.BOOL) }
  }

  return failCodec()
}

/**
 * Encodes an unknown raw attribute map.
 *
 * @param value - Candidate raw attribute map.
 * @returns Strict tagged map.
 */
function encodeUnknownAttributeMap(value: unknown): EncodedAttributeMap {
  const record = requireRecord(value)
  const encoded: Record<string, EncodedAttributeValue> = {}

  for (const name of Object.keys(record).sort(compareUtf8Ordinal)) {
    requireAttributeName(name)
    defineOwnProperty(encoded, name, encodeUnknownAttributeValue(record[name]))
  }

  return encoded
}

/**
 * Converts one raw attribute to its DocumentClient-like native value.
 *
 * @param value - Raw low-level DynamoDB attribute.
 * @returns Native JavaScript value.
 */
function decodeAttributeValueToNative(value: AttributeValue): unknown {
  const encoded = encodeAttributeValue(value)

  if (encoded.type === 'S') return encoded.value
  if (encoded.type === 'N') return decodeSafeNumber(encoded.value)
  if (encoded.type === 'B') return decodeCanonicalBase64(encoded.value)
  if (encoded.type === 'SS') return new Set(encoded.value)
  if (encoded.type === 'NS') {
    return new Set(encoded.value.map(decodeSafeNumber))
  }
  if (encoded.type === 'BS') {
    return new Set(encoded.value.map(decodeCanonicalBase64))
  }
  if (encoded.type === 'M') {
    const rawMap = decodeAttributeMap(encoded.value)
    return decodeAttributeMapToNativeRecord(rawMap)
  }
  if (encoded.type === 'L') {
    return encoded.value.map((entry) =>
      decodeAttributeValueToNative(decodeAttributeValue(entry))
    )
  }
  if (encoded.type === 'NULL') return null
  return encoded.value
}

/**
 * Decodes a tagged attribute list.
 *
 * @param value - Untrusted list.
 * @returns Raw AttributeValue list.
 */
function decodeAttributeList(value: unknown): AttributeValue[] {
  return requireArray(value).map(decodeAttributeValue)
}

/**
 * Decodes and canonicalizes a string set.
 *
 * @param value - Untrusted set members.
 * @returns UTF-8 ordinal sorted members.
 */
function decodeStringSet(value: unknown): string[] {
  const members = requireUniqueStringArray(value)
  const sorted = [...members].sort(compareUtf8Ordinal)
  if (!arraysEqual(members, sorted)) return failCodec()
  return sorted
}

/**
 * Decodes and canonicalizes a number set.
 *
 * @param value - Untrusted number spellings.
 * @returns UTF-8 ordinal sorted exact spellings.
 */
function decodeNumberSet(value: unknown): string[] {
  const members = requireUniqueNumberStringArray(value)
  const sorted = [...members].sort(compareUtf8Ordinal)
  if (!arraysEqual(members, sorted)) return failCodec()
  return sorted
}

/**
 * Decodes and canonicalizes a binary set.
 *
 * @param value - Untrusted base64 members.
 * @returns Byte-ordinal sorted binary members.
 */
function decodeBinarySet(value: unknown): Uint8Array[] {
  const encodedMembers = requireUniqueStringArray(value)
  const members = encodedMembers.map(decodeCanonicalBase64)
  const sorted = [...members].sort(compareBytes)
  if (!binaryArraysEqual(members, sorted)) return failCodec()
  return sorted
}

/**
 * Encodes bytes as canonical padded base64.
 *
 * @param value - Candidate bytes.
 * @returns Canonical base64.
 */
function encodeBinary(value: unknown): string {
  if (!(value instanceof Uint8Array)) return failCodec()
  return Buffer.from(value).toString('base64')
}

/**
 * Decodes canonical padded base64.
 *
 * @param value - Candidate base64 text.
 * @returns Decoded bytes.
 */
function decodeCanonicalBase64(value: unknown): Uint8Array {
  const text = requireString(value)
  if (
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)
  ) {
    return failCodec()
  }
  const bytes = Uint8Array.from(Buffer.from(text, 'base64'))
  if (Buffer.from(bytes).toString('base64') !== text) return failCodec()
  return bytes
}

/**
 * Reads an exact finite safe JavaScript number.
 *
 * @param value - Exact DynamoDB number spelling.
 * @returns Safe native number.
 */
function decodeSafeNumber(value: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return failCodec()
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) return failCodec()
  return number
}

/**
 * Validates one exact DynamoDB number spelling.
 *
 * @param value - Candidate value.
 * @returns Validated number spelling.
 */
function requireNumberString(value: unknown): string {
  const text = requireString(value)
  if (!canonicalNumberPattern.test(text)) return failCodec()
  return text
}

/**
 * Validates one non-empty unique string array.
 *
 * @param value - Candidate set members.
 * @returns Copied members.
 */
function requireUniqueStringArray(value: unknown): string[] {
  const members = requireArray(value).map(requireString)
  if (members.length === 0 || new Set(members).size !== members.length) {
    return failCodec()
  }
  return members
}

/**
 * Validates one non-empty unique number-string array.
 *
 * @param value - Candidate set members.
 * @returns Copied exact number spellings.
 */
function requireUniqueNumberStringArray(value: unknown): string[] {
  const members = requireArray(value).map(requireNumberString)
  const numericFingerprints = members.map(createNumberValueFingerprint)
  if (
    members.length === 0 ||
    new Set(numericFingerprints).size !== members.length
  ) {
    return failCodec()
  }
  return members
}

/**
 * Creates an exact equality fingerprint for one DynamoDB number spelling.
 *
 * @param value - Validated DynamoDB number text.
 * @returns Normalized integer coefficient and decimal exponent.
 */
function createNumberValueFingerprint(value: string): string {
  const exponentMarkerIndex = Math.max(
    value.indexOf('e'),
    value.indexOf('E'),
  )
  const mantissa = exponentMarkerIndex < 0
    ? value
    : value.slice(0, exponentMarkerIndex)
  const exponentText = exponentMarkerIndex < 0
    ? '0'
    : value.slice(exponentMarkerIndex + 1)
  const negative = mantissa.startsWith('-')
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa
  const decimalIndex = unsignedMantissa.indexOf('.')
  const fractionLength = decimalIndex < 0
    ? 0
    : unsignedMantissa.length - decimalIndex - 1
  let digits = unsignedMantissa.replace('.', '').replace(/^0+/u, '')
  if (!digits) return '0'

  let exponent = BigInt(exponentText) - BigInt(fractionLength)
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent += 1n
  }
  return `${negative ? '-' : ''}${digits}e${exponent}`
}

/**
 * Validates one non-empty unique binary array.
 *
 * @param value - Candidate set members.
 * @returns Copied binary members.
 */
function requireUniqueBinaryArray(value: unknown): Uint8Array[] {
  const members = requireArray(value).map((entry) => {
    if (!(entry instanceof Uint8Array)) return failCodec()
    return Uint8Array.from(entry)
  })
  if (members.length === 0) return failCodec()

  const fingerprints = members.map((entry) => Buffer.from(entry).toString('base64'))
  if (new Set(fingerprints).size !== fingerprints.length) return failCodec()
  return members
}

/**
 * Validates an attribute name.
 *
 * @param value - Candidate name.
 */
function requireAttributeName(value: string): void {
  if (!value || Buffer.byteLength(value, 'utf8') > 65_535) return failCodec()
}

/**
 * Requires one string.
 *
 * @param value - Candidate value.
 * @returns Validated string.
 */
function requireString(value: unknown): string {
  if (typeof value !== 'string') return failCodec()
  return value
}

/**
 * Requires one Boolean.
 *
 * @param value - Candidate value.
 * @returns Validated Boolean.
 */
function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return failCodec()
  return value
}

/**
 * Requires one array.
 *
 * @param value - Candidate value.
 * @returns Validated unknown array.
 */
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return failCodec()
  return value
}

/**
 * Requires one plain record.
 *
 * @param value - Candidate value.
 * @returns Validated record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failCodec()
  return value
}

/**
 * Checks for a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Defines an own data property without invoking the legacy `__proto__` setter.
 *
 * @param record - Destination attribute or native map.
 * @param name - Exact DynamoDB attribute name.
 * @param value - Property value.
 */
function defineOwnProperty<Value>(
  record: Record<string, Value>,
  name: string,
  value: Value,
): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/**
 * Requires exactly the expected property names.
 *
 * @param actual - Actual keys.
 * @param expected - Required keys.
 */
function requireExactKeys(actual: readonly string[], expected: readonly string[]): void {
  const sortedActual = [...actual].sort(compareUtf8Ordinal)
  const sortedExpected = [...expected].sort(compareUtf8Ordinal)
  if (!arraysEqual(sortedActual, sortedExpected)) return failCodec()
}

/**
 * Compares two string arrays.
 *
 * @param left - First array.
 * @param right - Second array.
 * @returns Whether both arrays are exactly equal.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index])
}

/**
 * Compares two binary arrays.
 *
 * @param left - First array.
 * @param right - Second array.
 * @returns Whether both arrays contain identical bytes in identical order.
 */
function binaryArraysEqual(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => {
      const candidate = right[index]
      return candidate !== undefined && compareBytes(value, candidate) === 0
    })
}

/**
 * Compares strings by their UTF-8 bytes.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive byte ordering.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Compares binary values by their bytes.
 *
 * @param left - First bytes.
 * @param right - Second bytes.
 * @returns Negative, zero, or positive byte ordering.
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/**
 * Raises the stable codec failure.
 *
 * @returns Never returns.
 */
function failCodec(): never {
  throw new DynamoDbAttributeCodecError()
}
