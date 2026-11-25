import { describe, expect, test } from 'bun:test'
import {
  isCatalogFileContentType,
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

  test('stores only canonical catalog media types and never SVG or HTML', () => {
    for (const contentType of [
      'image/png',
      'application/pdf',
      'text/csv',
      'text/markdown',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'application/vnd.jgraph.mxfile',
    ]) {
      expect(isCatalogFileContentType(contentType)).toBeTrue()
    }
    for (const contentType of [
      'image/svg+xml',
      'image/x-icon',
      'text/html',
      'text/xml',
      'application/x-msdownload',
      'application/octet-stream',
      '',
    ]) {
      expect(isCatalogFileContentType(contentType)).toBeFalse()
    }
  })

  test('keeps text and document types out of the inline-safe set', () => {
    expect(isInlineSafeFileContentType('image/webp')).toBeTrue()
    expect(isInlineSafeFileContentType('application/pdf')).toBeTrue()
    expect(isInlineSafeFileContentType('video/mp4')).toBeTrue()
    for (const contentType of ['text/plain', 'text/csv', 'application/json', 'application/zip']) {
      expect(isCatalogFileContentType(contentType)).toBeTrue()
      expect(isInlineSafeFileContentType(contentType)).toBeFalse()
    }
    expect(isInlineImageFileContentType('image/svg+xml')).toBeFalse()
  })
})
