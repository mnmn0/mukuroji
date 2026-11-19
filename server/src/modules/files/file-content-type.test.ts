import { describe, expect, test } from 'bun:test'
import {
  isAllowedFileContentType,
  isInlineImageFileContentType,
  isInlineSafeFileContentType,
  normalizeFileContentType,
} from './file-content-type'

describe('file content type policy', () => {
  test('normalizes parameters and case to a canonical media type', () => {
    expect(normalizeFileContentType(' Image/PNG ; charset=binary')).toBe('image/png')
    expect(normalizeFileContentType('text/plain;charset=utf-8')).toBe('text/plain')
  })

  test('rejects values that are not a single type/subtype token pair', () => {
    for (const value of ['image/png, text/html', 'image/', '/png', 'image png', 'image/png/extra', '']) {
      expect(normalizeFileContentType(value)).toBe('')
    }
  })

  test('accepts only allow-listed media types and never SVG', () => {
    expect(isAllowedFileContentType('image/png')).toBeTrue()
    expect(isAllowedFileContentType('application/pdf')).toBeTrue()
    expect(isAllowedFileContentType('text/csv')).toBeTrue()
    for (const contentType of ['image/svg+xml', 'image/x-icon', 'image/tiff', 'text/html', 'text/xml', '']) {
      expect(isAllowedFileContentType(contentType)).toBeFalse()
    }
  })

  test('keeps text and document types out of the inline-safe set', () => {
    expect(isInlineSafeFileContentType('image/webp')).toBeTrue()
    expect(isInlineSafeFileContentType('application/pdf')).toBeTrue()
    expect(isInlineSafeFileContentType('video/mp4')).toBeTrue()
    for (const contentType of ['text/plain', 'text/csv', 'application/json', 'application/zip']) {
      expect(isAllowedFileContentType(contentType)).toBeTrue()
      expect(isInlineSafeFileContentType(contentType)).toBeFalse()
    }
    expect(isInlineImageFileContentType('image/svg+xml')).toBeFalse()
  })
})
