import { DeveloperPlatformError } from '../errors'

/** Reads non-empty trimmed text at a Developer Platform boundary. */
export function readRequiredText(value: string, label: string) {
  if (typeof value !== 'string') {
    throw new DeveloperPlatformError(
      400,
      'DeveloperTextInvalid',
      `${label} must be a string.`,
    )
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new DeveloperPlatformError(
      400,
      'DeveloperTextInvalid',
      `${label} is required.`,
    )
  }
  return normalized
}

/** Reads a canonical Developer Platform identifier. */
export function readDeveloperIdentifier(value: string, label: string) {
  const normalized = readRequiredText(value, label)
  if (
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(normalized)
  ) {
    throw new DeveloperPlatformError(
      400,
      'DeveloperIdentifierInvalid',
      `${label} is invalid.`,
    )
  }
  return normalized
}

/** Reads a positive safe integer bounded by a caller-provided maximum. */
export function readPositiveInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DeveloperPlatformError(
      400,
      'DeveloperNumberInvalid',
      `${label} must be a positive integer no greater than ${maximum}.`,
    )
  }
  return value
}

/** Detects ASCII control characters, optionally allowing whitespace newlines. */
export function containsControlCharacter(value: string, allowNewline = false) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (
      code < 32 &&
      !(allowNewline && (code === 9 || code === 10 || code === 13))
    ) {
      return true
    }
    if (code === 127) return true
  }
  return false
}
