import { type GetUserResponse } from '../../modules/authentication'

/**
 * Reads a numeric JWT claim that may be encoded as a number or digit string.
 *
 * @param value - Raw claim value.
 * @returns The integer claim, or `undefined` when it is not numeric.
 */
export function readNumericClaim(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : undefined
}

/**
 * Reads a Cognito user attribute by name.
 *
 * @param user - Cognito user.
 * @param name - Attribute name.
 * @returns The attribute value, or `undefined` when it is absent.
 */
export function readUserAttribute(user: GetUserResponse, name: string) {
  return user.UserAttributes?.find((attribute) => attribute.Name === name)?.Value
}

/**
 * Decodes the payload segment of a JWT without verifying its signature.
 *
 * @param token - JWT to decode.
 * @returns The decoded payload, or `undefined` when the token is malformed.
 */
export function decodeJwtPayload<T>(token: string): T | undefined {
  const payload = token.split('.')[1]

  if (!payload) {
    return undefined
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - normalizedPayload.length % 4) % 4),
      '=',
    )
    const json = Buffer.from(paddedPayload, 'base64').toString('utf8')

    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}
