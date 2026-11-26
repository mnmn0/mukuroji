import type {
  PublicWorkItemWebLink,
  PublicWorkItemWebLinkList,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { WorkItemConfigurationApiError } from './errors'

const workItemsApiBaseUrl = resolveApiBaseUrl()

/** Message shown when the API gives no usable error message. */
const defaultApiErrorMessage = 'Unable to complete the Work Item link request.'

/**
 * Lists the web links of a Work Item, oldest first.
 *
 * @param accessToken - Access token sent in the Authorization header.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The links.
 * @throws WorkItemConfigurationApiError when the request fails or the response is malformed.
 */
export async function listWorkItemWebLinks(
  accessToken: string,
  teamId: string,
  workItemId: string,
): Promise<PublicWorkItemWebLink[]> {
  const data = await requestJson(createWebLinksPath(teamId, workItemId), accessToken)
  if (!isWebLinkList(data)) {
    throw new WorkItemConfigurationApiError(502, 'Work Item API returned an invalid link list.', 'InvalidWorkItemWebLinkResponse')
  }
  return data.items
}

/**
 * Adds a web link to a Work Item.
 *
 * @param accessToken - Access token sent in the Authorization header.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @param input - URL and optional title.
 * @param mutationContext - Mutation request context shared across retries.
 * @returns The added link.
 */
export async function createWorkItemWebLink(
  accessToken: string,
  teamId: string,
  workItemId: string,
  input: { url: string, title?: string },
  mutationContext: MutationRequestContext,
): Promise<PublicWorkItemWebLink> {
  const data = await requestJson(createWebLinksPath(teamId, workItemId), accessToken, {
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(mutationContext) },
    method: 'POST',
  })
  return readMutationLink(data)
}

/**
 * Removes a web link from a Work Item.
 *
 * @param accessToken - Access token sent in the Authorization header.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @param linkId - Link to remove.
 * @param mutationContext - Mutation request context shared across retries.
 * @returns The removed link.
 */
export async function deleteWorkItemWebLink(
  accessToken: string,
  teamId: string,
  workItemId: string,
  linkId: string,
  mutationContext: MutationRequestContext,
): Promise<PublicWorkItemWebLink> {
  const data = await requestJson(`${createWebLinksPath(teamId, workItemId)}/${encodeURIComponent(linkId)}`, accessToken, {
    headers: createMutationHeaders(mutationContext),
    method: 'DELETE',
  })
  return readMutationLink(data)
}

/**
 * Builds the path of a Work Item's links.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The path.
 */
function createWebLinksPath(teamId: string, workItemId: string) {
  return `${workItemsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(workItemId)}/web-links`
}

/**
 * Reads the link of a mutation response.
 *
 * @param data - Parsed response body.
 * @returns The link.
 * @throws WorkItemConfigurationApiError when the response is malformed.
 */
function readMutationLink(data: unknown): PublicWorkItemWebLink {
  const link: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'link') : undefined
  if (!isWebLink(link)) {
    throw new WorkItemConfigurationApiError(502, 'Work Item API returned an invalid link.', 'InvalidWorkItemWebLinkResponse')
  }
  return link
}

/**
 * Checks a link list response.
 *
 * @param value - Parsed response body.
 * @returns Whether it is a link list.
 */
function isWebLinkList(value: unknown): value is PublicWorkItemWebLinkList {
  if (typeof value !== 'object' || value === null) return false
  const items: unknown = Reflect.get(value, 'items')
  return Array.isArray(items) && items.every(isWebLink)
}

/**
 * Checks one link, accepting only `http` and `https` URLs so a link never runs script when opened.
 *
 * @param value - Value to check.
 * @returns Whether it is a link.
 */
function isWebLink(value: unknown): value is PublicWorkItemWebLink {
  if (typeof value !== 'object' || value === null) return false
  const id: unknown = Reflect.get(value, 'id')
  const url: unknown = Reflect.get(value, 'url')
  const title: unknown = Reflect.get(value, 'title')
  const createdByMemberId: unknown = Reflect.get(value, 'createdByMemberId')
  const createdAt: unknown = Reflect.get(value, 'createdAt')
  return typeof id === 'string' &&
    typeof url === 'string' && /^https?:\/\//iu.test(url) &&
    (title === undefined || typeof title === 'string') &&
    typeof createdByMemberId === 'string' &&
    typeof createdAt === 'string'
}

/**
 * Sends a request and reads its JSON body.
 *
 * @param path - Request URL.
 * @param accessToken - Access token sent in the Authorization header.
 * @param init - Request options.
 * @returns The parsed body.
 * @throws WorkItemConfigurationApiError when the response is not successful.
 */
async function requestJson(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
  })
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
  }
  if (!response.ok) {
    const message: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'message') : undefined
    const code: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined
    throw new WorkItemConfigurationApiError(
      response.status,
      typeof message === 'string' && message.trim() ? message.trim() : defaultApiErrorMessage,
      typeof code === 'string' ? code : undefined,
    )
  }
  return data
}
