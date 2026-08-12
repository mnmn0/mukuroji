import { types as nodeUtilTypes } from 'node:util'
import {
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
} from './migration-contract'
import {
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

const maximumTextLength = 8_192
const maximumVersionIdLength = 1_024
const maximumS3ObjectKeyByteLength = 1_024

/**
 * Shared strict record and descriptor guards for migration trust boundaries.
 *
 * Each consumer injects its own stable failure callback so shared validation
 * cannot leak a lower-level error across the consumer's public boundary.
 */
export class WorkspaceSearchMigrationStrictRecordGuards {
  /** Consumer-owned stable failure callback. */
  private readonly fail: () => never

  /**
   * Creates strict guards bound to one public failure boundary.
   *
   * @param fail - Consumer-owned callback that raises its stable failure.
   */
  constructor(fail: () => never) {
    this.fail = fail
  }

  /**
   * Checks whether one value is an ordinary non-array, non-proxy object.
   *
   * @param value - Candidate value.
   * @returns Whether the candidate can be inspected as an ordinary record.
   */
  isRecord(value: unknown): value is object {
    return typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !nodeUtilTypes.isProxy(value)
  }

  /**
   * Requires one ordinary non-array, non-proxy record.
   *
   * @param value - Candidate record.
   * @returns Validated record.
   */
  requireRecord(value: unknown): object {
    if (!this.isRecord(value)) {
      return this.fail()
    }
    return value
  }

  /**
   * Requires exactly the declared enumerable own data properties.
   *
   * @param value - Validated record.
   * @param expected - Exact required key set.
   */
  requireExactKeys(
    value: object,
    expected: readonly string[],
  ): void {
    const keys = Object.keys(value).sort()
    const ownKeys = Reflect.ownKeys(value)
    const expectedKeys = [...expected].sort()
    if (
      ownKeys.some((key) => typeof key !== 'string') ||
      ownKeys.length !== keys.length ||
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return this.fail()
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return this.fail()
      }
    }
  }

  /**
   * Reads one required enumerable own data property.
   *
   * @param value - Validated record.
   * @param key - Required property name.
   * @returns Exact untrusted value.
   */
  readOwn(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return this.fail()
    }
    return descriptor.value
  }

  /**
   * Reads one safe migration identifier through the canonical validator.
   *
   * @param value - Candidate identifier.
   * @returns Exact identifier.
   */
  readIdentifier(value: unknown): string {
    if (typeof value !== 'string') {
      return this.fail()
    }
    try {
      requireMigrationIdentifier(value, 'Migration identifier')
    } catch {
      return this.fail()
    }
    return value
  }

  /**
   * Reads one conventional lowercase SHA-256 digest.
   *
   * @param value - Candidate digest.
   * @returns Exact digest.
   */
  readDigest(value: unknown): string {
    if (!isHexDigest(value)) {
      return this.fail()
    }
    return value
  }

  /**
   * Reads one canonical UTC millisecond timestamp.
   *
   * @param value - Candidate timestamp.
   * @returns Exact timestamp.
   */
  readTimestamp(value: unknown): string {
    if (!isCanonicalTimestamp(value)) {
      return this.fail()
    }
    return value
  }

  /**
   * Reads one bounded nonempty safe text value.
   *
   * @param value - Candidate text.
   * @returns Exact text.
   */
  readText(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maximumTextLength ||
      value !== value.trim() ||
      !hasOnlyPairedSurrogates(value)
    ) {
      return this.fail()
    }
    return value
  }

  /**
   * Reads one bounded immutable object version identifier.
   *
   * @param value - Candidate version identifier.
   * @returns Exact version identifier.
   */
  readVersionId(value: unknown): string {
    const versionId = this.readText(value)
    if (
      versionId.length > maximumVersionIdLength ||
      versionId === 'null'
    ) {
      return this.fail()
    }
    return versionId
  }

  /**
   * Reads one bounded S3 object key using the service's UTF-8 byte limit.
   *
   * @param value - Candidate S3 object key.
   * @returns Exact object key.
   */
  readS3ObjectKey(value: unknown): string {
    const objectKey = this.readText(value)
    if (
      new TextEncoder().encode(objectKey).byteLength >
        maximumS3ObjectKeyByteLength
    ) {
      return this.fail()
    }
    return objectKey
  }

  /**
   * Reads one Uint8Array's intrinsic backing buffer without own accessors.
   *
   * @param value - Valid non-proxy Uint8Array.
   * @returns Exact intrinsic ArrayBuffer or SharedArrayBuffer.
   */
  readIntrinsicBuffer(value: Uint8Array): ArrayBufferLike {
    const typedArrayPrototype = Object.getPrototypeOf(
      Uint8Array.prototype,
    )
    const descriptor = typedArrayPrototype === null
      ? undefined
      : Object.getOwnPropertyDescriptor(
          typedArrayPrototype,
          'buffer',
        )
    if (descriptor?.get === undefined) {
      return this.fail()
    }
    try {
      const result: unknown = Reflect.apply(
        descriptor.get,
        value,
        [],
      )
      if (
        !nodeUtilTypes.isArrayBuffer(result) &&
        !nodeUtilTypes.isSharedArrayBuffer(result)
      ) {
        return this.fail()
      }
      return result
    } catch {
      return this.fail()
    }
  }

  /**
   * Reads one Uint8Array's intrinsic byte length without own accessors.
   *
   * @param value - Valid non-proxy Uint8Array.
   * @returns Exact intrinsic byte length.
   */
  readIntrinsicByteLength(value: Uint8Array): number {
    const typedArrayPrototype = Object.getPrototypeOf(
      Uint8Array.prototype,
    )
    const descriptor = typedArrayPrototype === null
      ? undefined
      : Object.getOwnPropertyDescriptor(
          typedArrayPrototype,
          'byteLength',
        )
    if (descriptor?.get === undefined) {
      return this.fail()
    }
    try {
      const result: unknown = Reflect.apply(
        descriptor.get,
        value,
        [],
      )
      if (
        typeof result !== 'number' ||
        !Number.isSafeInteger(result)
      ) {
        return this.fail()
      }
      return result
    } catch {
      return this.fail()
    }
  }
}
