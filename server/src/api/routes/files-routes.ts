import type { Hono } from 'hono'
import {
  type CreateFileAnnotationInput,
  type CreateFileUploadInput,
} from '../../modules/files/file-proofing'
import { workItemDependencies } from '../shared/app-dependencies'
import { loadFileProofingRequestContext } from '../shared/collaboration-access'
import { readFileProofingJson, toFileProofingErrorResponse } from '../shared/file-approval-access'
import { readBearerAccessToken } from '../shared/http'
import { readRequiredRouteId } from '../shared/input-parsing'
import { createApiMutationContext } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

const fileCollectionRoutes = [
  {
    basePath: '/api/teams/:teamId/issues/:issueId/files',
    kind: 'work-item',
  },
  {
    basePath: '/api/teams/:teamId/projects/:projectId/files',
    kind: 'project',
  },
] as const

/**
 * Registers the files HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerFilesRoutes(routeApp: Hono): void {
  for (const fileRoute of fileCollectionRoutes) {
    /** Work Item または Team scoped Project の file/approval 一覧 endpoint です。 */
    routeApp.get(fileRoute.basePath, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        return c.json(await workItemDependencies.fileProofing.list(scope, actor))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Work Item または Project へ新規 file upload session を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/uploads`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
        return c.json(
          await workItemDependencies.fileProofing.createUpload(
            scope,
            actor,
            body,
            createApiMutationContext(c, principal, body),
          ),
          201,
        )
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** 既存 file の新 version upload session を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileUploadInput>(c.req)
        return c.json(
          await workItemDependencies.fileProofing.createVersionUpload(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            body,
            createApiMutationContext(c, principal, body),
          ),
          201,
        )
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Direct upload 完了後に object metadata と scan state を検証する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/complete`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const input = {
          fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
        }
        return c.json(await workItemDependencies.fileProofing.completeUpload(
          scope,
          actor,
          input.fileId,
          input.versionId,
          createApiMutationContext(c, principal, input),
        ))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Clean version の短命 preview/download URL を発行する endpoint です。 */
    routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/access`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const disposition = c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline'
        const input = {
          fileId: readRequiredRouteId(c.req.param('fileId'), 'File ID'),
          versionId: readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
          disposition,
        } as const
        return c.json(await workItemDependencies.fileProofing.createAccess(
          scope,
          actor,
          input.fileId,
          input.versionId,
          disposition,
          createApiMutationContext(c, principal, input),
        ))
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Version の位置 annotation 一覧 endpoint です。 */
    routeApp.get(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        return c.json({
          annotations: await workItemDependencies.fileProofing.listAnnotations(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
          ),
        })
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** Version preview 上へ位置 annotation を作成する endpoint です。 */
    routeApp.post(`${fileRoute.basePath}/:fileId/versions/:versionId/annotations`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const body = await readFileProofingJson<CreateFileAnnotationInput>(c.req)
        return c.json({
          annotation: await workItemDependencies.fileProofing.createAnnotation(
            scope,
            actor,
            readRequiredRouteId(c.req.param('fileId'), 'File ID'),
            readRequiredRouteId(c.req.param('versionId'), 'Version ID'),
            body,
            createApiMutationContext(c, principal, body),
          ),
        }, 201)
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })

    /** File を retention 付きで soft delete する endpoint です。 */
    routeApp.delete(`${fileRoute.basePath}/:fileId`, async (c) => {
      const accessToken = readBearerAccessToken(c)
      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { scope, actor } = await loadFileProofingRequestContext(c, principal, fileRoute.kind)
        const fileId = readRequiredRouteId(c.req.param('fileId'), 'File ID')
        await workItemDependencies.fileProofing.deleteFile(
          scope,
          actor,
          fileId,
          createApiMutationContext(c, principal, { fileId }),
        )
        return c.body(null, 204)
      } catch (error) {
        return toFileProofingErrorResponse(c, error)
      }
    })
  }
}
