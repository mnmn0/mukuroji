import { describe, expect, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  decodeAttributeMapToNativeRecord,
  decodeAttributeValue,
  DynamoDbAttributeCodecError,
  encodeAttributeMap,
  encodeAttributeValue,
  parseCanonicalAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'

/**
 * Creates an item containing every DynamoDB AttributeValue variant.
 *
 * @returns Complete raw low-level DynamoDB item.
 */
function createCompleteItem(): Record<string, AttributeValue> {
  return {
    binary: { B: Uint8Array.from([0, 1, 2, 255]) },
    binarySet: {
      BS: [
        Uint8Array.from([255]),
        Uint8Array.from([0, 1]),
      ],
    },
    boolean: { BOOL: false },
    list: {
      L: [
        { S: 'first' },
        { NULL: true },
        { M: { nested: { N: '1.00e+2' } } },
      ],
    },
    map: {
      M: {
        z: { S: 'last' },
        a: { S: 'first' },
      },
    },
    null: { NULL: true },
    number: { N: '1.00e+2' },
    numberSet: { NS: ['2.0', '-1', '1e+1'] },
    string: { S: 'こんにちは' },
    stringSet: { SS: ['zebra', 'alpha'] },
  }
}

describe('DynamoDB AttributeValue codec', () => {
  test('round-trips every attribute type with canonical maps, sets, and binary', () => {
    const item = createCompleteItem()
    const encoded = encodeAttributeMap(item)
    const decoded = decodeAttributeMap(encoded)
    const serialized = serializeCanonicalAttributeMap(item)

    expect(encoded).toEqual({
      binary: { type: 'B', value: 'AAEC/w==' },
      binarySet: { type: 'BS', value: ['AAE=', '/w=='] },
      boolean: { type: 'BOOL', value: false },
      list: {
        type: 'L',
        value: [
          { type: 'S', value: 'first' },
          { type: 'NULL' },
          {
            type: 'M',
            value: { nested: { type: 'N', value: '1.00e+2' } },
          },
        ],
      },
      map: {
        type: 'M',
        value: {
          a: { type: 'S', value: 'first' },
          z: { type: 'S', value: 'last' },
        },
      },
      null: { type: 'NULL' },
      number: { type: 'N', value: '1.00e+2' },
      numberSet: { type: 'NS', value: ['-1', '1e+1', '2.0'] },
      string: { type: 'S', value: 'こんにちは' },
      stringSet: { type: 'SS', value: ['alpha', 'zebra'] },
    })
    expect(serializeCanonicalAttributeMap(decoded)).toBe(serialized)
    expect(parseCanonicalAttributeMap(serialized)).toEqual(decoded)
    expect(decodeAttributeValue(encodeAttributeValue({ NULL: true })))
      .toEqual({ NULL: true })
  })

  test('round-trips exact key and item maps with stable canonical digests', () => {
    const firstKey = {
      recordKey: { S: 'DOCUMENT#work-item#example' },
      workspaceId: { S: 'workspace-example' },
    }
    const secondKey = {
      workspaceId: { S: 'workspace-example' },
      recordKey: { S: 'DOCUMENT#work-item#example' },
    }
    const firstItem = createCompleteItem()
    const secondItem = {
      stringSet: { SS: ['alpha', 'zebra'] },
      ...createCompleteItem(),
      numberSet: { NS: ['1e+1', '2.0', '-1'] },
    }

    expect(parseCanonicalAttributeMap(serializeCanonicalAttributeMap(firstKey)))
      .toEqual(firstKey)
    expect(serializeCanonicalAttributeMap(firstKey))
      .toBe(serializeCanonicalAttributeMap(secondKey))
    expect(createAttributeMapDigest(firstKey)).toBe(createAttributeMapDigest(secondKey))
    expect(createAttributeMapDigest(firstItem)).toBe(createAttributeMapDigest(secondItem))
    expect(createAttributeMapDigest(firstKey)).toMatch(/^[a-f0-9]{64}$/u)
  })

  test('preserves attribute names that overlap with object prototype properties', () => {
    const item = Object.fromEntries([
      ['__proto__', { S: 'prototype-value' }],
      ['constructor', { S: 'constructor-value' }],
    ])
    const serialized = serializeCanonicalAttributeMap(item)
    const decoded = parseCanonicalAttributeMap(serialized)
    const native = decodeAttributeMapToNativeRecord(decoded)
    const nativeConstructor: unknown = native.constructor

    expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
    expect(decoded.__proto__).toEqual({ S: 'prototype-value' })
    expect(Object.hasOwn(native, '__proto__')).toBe(true)
    expect(native.__proto__).toBe('prototype-value')
    expect(nativeConstructor).toBe('constructor-value')
    expect(() => decodeAttributeMap(new Date())).toThrow(
      DynamoDbAttributeCodecError,
    )
  })

  test('decodes raw maps to mapper-native records without assertions', () => {
    const native = decodeAttributeMapToNativeRecord(createCompleteItem())

    expect(native).toMatchObject({
      boolean: false,
      null: null,
      number: 100,
      string: 'こんにちは',
    })
    expect(native.binary).toEqual(Uint8Array.from([0, 1, 2, 255]))
    expect(native.stringSet).toEqual(new Set(['alpha', 'zebra']))
    expect(native.numberSet).toEqual(new Set([-1, 10, 2]))
    expect(native.map).toEqual({ a: 'first', z: 'last' })
    expect(native.list).toEqual(['first', null, { nested: 100 }])
  })

  test('rejects unsafe integers at every mapper-native number boundary', () => {
    const unsafeItems: Record<string, AttributeValue>[] = [
      { unsafe: { N: '9007199254740993' } },
      { unsafe: { NS: ['1', '9007199254740993'] } },
      { unsafe: { L: [{ N: '9007199254740993' }] } },
    ]

    for (const item of unsafeItems) {
      expect(() => decodeAttributeMapToNativeRecord(item)).toThrow(
        DynamoDbAttributeCodecError,
      )
    }
  })

  test('rejects precision-losing decimals at every mapper-native number boundary', () => {
    const precisionLosingItems: Record<string, AttributeValue>[] = [
      { imprecise: { N: '1.0000000000000001' } },
      { imprecise: { NS: ['0.1', '1.0000000000000001'] } },
      { imprecise: { L: [{ N: '1.0000000000000001' }] } },
    ]

    for (const item of precisionLosingItems) {
      expect(() => decodeAttributeMapToNativeRecord(item)).toThrow(
        DynamoDbAttributeCodecError,
      )
    }

    expect(decodeAttributeMapToNativeRecord({
      decimal: { N: '0.1' },
      exponent: { N: '1.00e+2' },
    })).toEqual({
      decimal: 0.1,
      exponent: 100,
    })
  })

  test('rejects tampered tags, members, base64, sets, and non-canonical text', () => {
    const invalidValues: unknown[] = [
      { type: 'UNKNOWN', value: 'secret-canary' },
      { type: 'NULL', value: true },
      { type: 'BOOL', value: true, extra: 'secret-canary' },
      { type: 'B', value: 'not-base64' },
      { type: 'N', value: '01' },
      { type: 'SS', value: [] },
      { type: 'SS', value: ['duplicate', 'duplicate'] },
      { type: 'SS', value: ['zebra', 'alpha'] },
      { type: 'NS', value: ['1', '1.0'] },
      { type: 'NS', value: ['-0', '0e+10'] },
      { type: 'BS', value: ['/w==', 'AAE='] },
    ]

    for (const value of invalidValues) {
      expect(() => decodeAttributeValue(value)).toThrow(DynamoDbAttributeCodecError)
    }

    const canonical = serializeCanonicalAttributeMap(createCompleteItem())
    expect(() => parseCanonicalAttributeMap(` ${canonical}`))
      .toThrow(DynamoDbAttributeCodecError)
    expect(() => parseCanonicalAttributeMap(
      canonical.replace('"AAEC/w=="', '"AAEC/w="'),
    )).toThrow(DynamoDbAttributeCodecError)
    expect(() => decodeAttributeMap({
      attribute: { type: 'S', value: 'ok', extra: 'secret-canary' },
    })).toThrow(DynamoDbAttributeCodecError)
    expect(() => encodeAttributeValue({
      $unknown: ['future-secret-canary', {}],
    })).toThrow(DynamoDbAttributeCodecError)
  })

  test('uses stable raw-value-free failures', () => {
    try {
      decodeAttributeValue({ type: 'S', value: 42, canary: 'tenant-secret-canary' })
      throw new Error('Expected codec failure.')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DynamoDbAttributeCodecError)
      expect(error).toMatchObject({
        code: 'INVALID_DYNAMODB_ATTRIBUTE',
        message: 'INVALID_DYNAMODB_ATTRIBUTE',
      })
      expect(String(error)).not.toContain('tenant-secret-canary')
    }
  })
})
