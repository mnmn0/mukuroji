import { Hono, type Context } from 'hono'
import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  CreateCustomerRequestInput,
  CreateCustomerRequestFromTriageInput,
  CreateCustomerSavedViewInput,
  Customer,
  CustomerContact,
  CustomerDetail,
  CustomerImpactSignal,
  CustomerListInput,
  CustomerRequest,
  CustomerRequestSource,
  CustomerSavedView,
  CustomerWorkItemSummary,
  CustomerWorkspaceExport,
  LinkCustomerRequestProjectInput,
  LinkCustomerRequestWorkItemInput,
  MergeCustomerContactInput,
  MergeCustomerInput,
  MergeCustomerRequestInput,
  TriageEntry,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
  UpdateCustomerSavedViewInput,
  UpdateTriageCustomerAssociationInput,
} from '@mukuroji/contracts'
import {
  CustomerError,
  projectCustomerImpactSignal,
} from '../../domain/customer'
import type {
  CustomerAuthorizationConditionChecks,
  CustomerClient,
  CustomerWorkItemProjectResolver,
} from '../../customers'
import type {
  TriageAuthorizationConditionChecks,
  TriageClient,
  TriageCustomerAssociationAuthorizationFactory,
} from '../../../triage'

/** Minimum authenticated Workspace identity required by Customer routes. */
export type CustomerPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Stable authenticated actor identifier. */
  userKey: string
  /** Whether internal Customer attributes and request content may be returned. */
  canViewSensitiveData: boolean
}

/** Resource used when a Customer route is authorized through a scoped access check. */
export type CustomerAuthorizationScope =
  | {
      /** Team that owns the Customer operation's canonical resource. */
      teamId: string
      /** Project scope is mutually exclusive with a Team scope. */
      projectId?: never
    }
  | {
      /** Project that owns the Customer operation's canonical resource. */
      projectId: string
      /** Team scope is mutually exclusive with a Project scope. */
      teamId?: never
    }

/** Result of resolving a Work Item for a Customer Request link. */
export type CustomerWorkItemAuthorization = {
  /** Project assigned to the Work Item, when available. */
  projectId?: string
  /** Whether the canonical Work Item is currently completed. */
  isCompleted: boolean
  /** Live Work Item, Team, Project, and actor fences for the Customer write. */
  authorizationConditionChecks?: TriageAuthorizationConditionChecks
}

/** Result of resolving and authorizing a Project for a Customer write. */
export type CustomerProjectAuthorization = {
  /** Live Team, Project, and actor fences for the Customer write. */
  authorizationConditionChecks?: TriageAuthorizationConditionChecks
}

/** Dependencies injected into the Customer HTTP adapter. */
export type CustomerRouterDependencies<Principal extends CustomerPrincipal = CustomerPrincipal> = {
  /** Returns the Customer application client. */
  getCustomers(): CustomerClient
  /** Authenticates and authorizes the current Workspace request. */
  requireWorkspaceAccess(context: Context, minimum: 'read' | 'write' | 'manage', scope?: CustomerAuthorizationScope): Promise<Principal>
  /** Verifies Team access before associating a Triage Entry. */
  verifyTriageAccess(principal: Principal, teamId: string, minimum: 'viewer' | 'member'): Promise<void>
  /** Verifies and fences a Customer owner as an active non-guest Workspace member. */
  verifyCustomerOwner(principal: Principal, ownerUserId: string): Promise<CustomerAuthorizationConditionChecks>
  /** Builds the same live Team, Project, and actor fences used by Triage mutations. */
  createTriageAuthorizationConditionChecks: (
    principal: Principal,
    teamId: string,
    projectIds: readonly (string | undefined)[],
  ) => Promise<TriageAuthorizationConditionChecks>
  /** Resolves and authorizes a Work Item before creating a customer link. */
  verifyWorkItemAccess(principal: Principal, teamId: string, workItemId: string, minimum: 'viewer' | 'member'): Promise<CustomerWorkItemAuthorization>
  /** Resolves and authorizes a Project before reading or mutating its associations. */
  verifyProjectAccess(principal: Principal, projectId: string, minimum: 'viewer' | 'member'): Promise<CustomerProjectAuthorization>
  /** Returns the Triage operations used for Customer associations. */
  getTriage(): Pick<TriageClient, 'getEntry' | 'associateCustomer' | 'listCustomerAssociations' | 'clearCustomerAssociations'>
  /** Safely parses a JSON request body. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Maps Customer, authentication, authorization, and persistence failures to HTTP. */
  mapError(context: Context, error: unknown): Response
}

/** Creates Workspace-scoped Customer directory, request, impact, and lifecycle routes.
 *
 * @param dependencies Authentication, authorization, application, and response dependencies.
 * @returns A Hono router containing Customer HTTP routes.
 */
export function createCustomerRouter<Principal extends CustomerPrincipal = CustomerPrincipal>(dependencies: CustomerRouterDependencies<Principal>): Hono {
  const router = new Hono()

  router.get('/api/customers/export', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      return context.json(await projectExport(principal, await dependencies.getCustomers().exportWorkspace(principal.directoryId), dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/report', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const input = readCustomerListInput(context)
      requireRestrictedCustomerFilters(principal, input)
      const page = await dependencies.getCustomers().listCustomers(principal.directoryId, input)
      return context.json({
        ...page,
        customers: page.customers.map((customer) => projectCustomer(principal, customer)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/views', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const views = await dependencies.getCustomers().listSavedViews(principal.directoryId)
      return context.json({ views: views.map((view) => projectSavedView(principal, view)) })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers/views', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const input = readCreateSavedViewInput(await dependencies.readJson(context.req))
      requireRestrictedCustomerFilters(principal, input.filters)
      const view = await dependencies.getCustomers().createSavedView(
        principal.directoryId,
        principal.userKey,
        input,
        readIdempotencyKey(context.req.header('Idempotency-Key')),
      )
      return context.json(projectSavedView(principal, view), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/views/:viewId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const input = readUpdateSavedViewInput(await dependencies.readJson(context.req))
      if (input.filters) requireRestrictedCustomerFilters(principal, input.filters)
      const view = await dependencies.getCustomers().updateSavedView(
        principal.directoryId,
        context.req.param('viewId') ?? '',
        principal.userKey,
        input,
      )
      return context.json(projectSavedView(principal, view))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customers/views/:viewId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      await dependencies.getCustomers().deleteSavedView(
        principal.directoryId,
        context.req.param('viewId') ?? '',
        principal.userKey,
        readExpectedRevision(context.req.query('expectedRevision')),
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const input = readCustomerListInput(context)
      requireRestrictedCustomerFilters(principal, input)
      const page = await dependencies.getCustomers().listCustomers(principal.directoryId, input)
      return context.json({
        ...page,
        customers: page.customers.map((customer) => projectCustomer(principal, customer)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const idempotencyKey = readIdempotencyKey(context.req.header('Idempotency-Key'))
      const input = readCreateCustomerInput(await dependencies.readJson(context.req))
      const authorizationConditionChecks = input.ownerUserId === undefined
        ? undefined
        : await dependencies.verifyCustomerOwner(principal, input.ownerUserId)
      const customer = await dependencies.getCustomers().createCustomer(
        principal.directoryId,
        principal.userKey,
        input,
        authorizationConditionChecks,
        idempotencyKey,
      )
      return context.json(projectCustomer(principal, customer), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/:customerId/work-items', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json({
        workItems: await projectCustomerWorkItems(
          principal,
          await dependencies.getCustomers().listCustomerWorkItems(
            principal.directoryId,
            context.req.param('customerId') ?? '',
          ),
          dependencies,
        ),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/:customerId/contacts', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const contacts = await dependencies.getCustomers().listContacts(
        principal.directoryId,
        context.req.param('customerId') ?? '',
      )
      return context.json({ contacts: contacts.map((contact) => projectContact(principal, contact)) })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers/:customerId/contacts', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const input = readCreateContactInput(await dependencies.readJson(context.req))
      const contact = await dependencies.getCustomers().createContact(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        input,
        readIdempotencyKey(context.req.header('Idempotency-Key')),
      )
      return context.json(projectContact(principal, contact), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json(await projectCustomerDetail(principal, await dependencies.getCustomers().getCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
      ), dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const input = readUpdateCustomerInput(await dependencies.readJson(context.req))
      const authorizationConditionChecks = input.ownerUserId === undefined || input.ownerUserId === null
        ? undefined
        : await dependencies.verifyCustomerOwner(principal, input.ownerUserId)
      const customer = await dependencies.getCustomers().updateCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        input,
        authorizationConditionChecks,
      )
      return context.json(projectCustomer(principal, customer))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const customerId = context.req.param('customerId') ?? ''
      const expectedRevision = readExpectedRevision(context.req.query('expectedRevision'))
      const triage = dependencies.getTriage()
      if (!triage.clearCustomerAssociations || !triage.listCustomerAssociations) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage Customer association cleanup is unavailable.')
      }
      const customers = dependencies.getCustomers()
      const authorizeAssociation: TriageCustomerAssociationAuthorizationFactory = async (entry) => {
        await dependencies.verifyTriageAccess(principal, entry.teamId, 'member')
        return await dependencies.createTriageAuthorizationConditionChecks(
          principal,
          entry.teamId,
          [entry.projectId],
        )
      }
      const associations = await triage.listCustomerAssociations(
        principal.directoryId,
        customerId,
      )
      await Promise.all(associations.map((entry) => authorizeAssociation(entry)))
      await customers.beginCustomerDeletion(
        principal.directoryId,
        customerId,
        principal.userKey,
        expectedRevision,
      )
      await triage.clearCustomerAssociations(
        principal.directoryId,
        customerId,
        principal.userKey,
        authorizeAssociation,
      )
      await customers.completeCustomerDeletion(
        principal.directoryId,
        customerId,
        principal.userKey,
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers/:customerId/merge', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const triage = dependencies.getTriage()
      if (!triage.associateCustomer || !triage.listCustomerAssociations) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage Customer association repointing is unavailable.')
      }
      const customers = dependencies.getCustomers()
      const listCustomerAssociations = triage.listCustomerAssociations.bind(triage)
      const sourceCustomerId = context.req.param('customerId') ?? ''
      const input = readMergeCustomerInput(await dependencies.readJson(context.req))
      /** Reads and authorizes the complete source-side Triage association snapshot. */
      const readAuthorizedAssociations = async (): Promise<Array<{
        entry: TriageEntry
        authorizationConditionChecks?: TriageAuthorizationConditionChecks
      }>> => {
        const associations = await listCustomerAssociations(
          principal.directoryId,
          sourceCustomerId,
        )
        const authorizedAssociations: Array<{
          entry: TriageEntry
          authorizationConditionChecks?: TriageAuthorizationConditionChecks
        }> = []
        for (const entry of associations) {
          const authorizationConditionChecks = await dependencies.createTriageAuthorizationConditionChecks(
            principal,
            entry.teamId,
            [entry.projectId],
          )
          authorizedAssociations.push({ entry, authorizationConditionChecks })
        }
        return authorizedAssociations
      }
      await readAuthorizedAssociations()
      await customers.beginCustomerMerge(
        principal.directoryId,
        sourceCustomerId,
        principal.userKey,
        input,
      )
      const authorizedAssociations = await readAuthorizedAssociations()
      for (const { entry, authorizationConditionChecks } of authorizedAssociations) {
        await triage.associateCustomer(
          principal.directoryId,
          entry.teamId,
          entry.id,
          { id: principal.userKey },
          {
            expectedRevision: entry.revision,
            customerId: input.targetCustomerId,
            contactId: entry.contactId ?? null,
            customerRequestId: entry.customerRequestId ?? null,
          },
          authorizationConditionChecks,
          {
            kind: 'merge',
            sourceCustomerId,
            targetCustomerId: input.targetCustomerId,
          },
        )
      }
      const detail = await customers.completeCustomerMerge(
        principal.directoryId,
        sourceCustomerId,
        principal.userKey,
        input,
      )
      try {
        return context.json(await projectCustomerDetail(principal, detail, dependencies))
      } catch {
        return context.json(projectCommittedCustomerDetail(principal, detail))
      }
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/:customerId/contacts/:contactId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const contact = await dependencies.getCustomers().updateContact(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        context.req.param('contactId') ?? '',
        principal.userKey,
        readUpdateContactInput(await dependencies.readJson(context.req)),
      )
      return context.json(projectContact(principal, contact))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customers/:customerId/contacts/:contactId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const customerId = context.req.param('customerId') ?? ''
      const contactId = context.req.param('contactId') ?? ''
      const expectedRevision = readExpectedRevision(context.req.query('expectedRevision'))
      const customers = dependencies.getCustomers()
      await assertContactMutationAllowed(principal.directoryId, customerId, contactId, dependencies)
      await customers.beginCustomerContactDeletion(
        principal.directoryId,
        customerId,
        contactId,
        principal.userKey,
        expectedRevision,
      )
      try {
        await assertContactMutationAllowed(principal.directoryId, customerId, contactId, dependencies)
      } catch (error) {
        try {
          await customers.cancelCustomerContactDeletion(
            principal.directoryId,
            customerId,
            contactId,
            principal.userKey,
            expectedRevision,
          )
        } catch (cancelError) {
          throw new CustomerError(
            503,
            'CustomerContactMutationCancellationFailed',
            'The Contact deletion could not be safely prepared. Retry the operation.',
            { cause: cancelError },
          )
        }
        throw error
      }
      await customers.completeCustomerContactDeletion(
        principal.directoryId,
        customerId,
        contactId,
        principal.userKey,
        expectedRevision,
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-contacts/:contactId/merge', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const input = readMergeContactInput(await dependencies.readJson(context.req))
      const sourceContactId = context.req.param('contactId') ?? ''
      const sourceContact = await dependencies.getCustomers().getContactById(
        principal.directoryId,
        sourceContactId,
      )
      await assertContactMutationAllowed(
        principal.directoryId,
        sourceContact.customerId,
        sourceContactId,
        dependencies,
      )
      const customers = dependencies.getCustomers()
      await customers.beginCustomerContactMerge(
        principal.directoryId,
        sourceContactId,
        principal.userKey,
        input,
      )
      try {
        await assertContactMutationAllowed(
          principal.directoryId,
          sourceContact.customerId,
          sourceContactId,
          dependencies,
        )
      } catch (error) {
        try {
          await customers.cancelCustomerContactMerge(
            principal.directoryId,
            sourceContactId,
            principal.userKey,
            input,
          )
        } catch (cancelError) {
          throw new CustomerError(
            503,
            'CustomerContactMutationCancellationFailed',
            'The Contact merge could not be safely prepared. Retry the operation.',
            { cause: cancelError },
          )
        }
        throw error
      }
      const contact = await customers.completeCustomerContactMerge(
        principal.directoryId,
        sourceContactId,
        principal.userKey,
        input,
      )
      return context.json(projectContact(principal, contact))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customer-requests', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const input = readRequestListInput(context)
      requireRestrictedSearch(principal, input.search)
      const page = await dependencies.getCustomers().listRequests(principal.directoryId, input)
      return context.json({
        ...page,
        requests: await Promise.all(page.requests.map((request) => projectRequestForResponse(principal, request, dependencies))),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const body = await dependencies.readJson(context.req)
      const request = await dependencies.getCustomers().createRequest(
        principal.directoryId,
        principal.userKey,
        readCreateRequestInput(body, readIdempotencyKey(context.req.header('Idempotency-Key'))),
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customer-requests/:requestId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json(await projectRequestForResponse(principal, await dependencies.getCustomers().getRequest(
        principal.directoryId,
        context.req.param('requestId') ?? '',
      ), dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customer-requests/:requestId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const request = await dependencies.getCustomers().updateRequest(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        readUpdateRequestInput(await dependencies.readJson(context.req)),
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const customers = dependencies.getCustomers()
      const requestId = context.req.param('requestId') ?? ''
      const request = await customers.getRequest(principal.directoryId, requestId)
      const expectedRevision = readExpectedRevision(context.req.query('expectedRevision'))
      await customers.beginCustomerRequestDeletion(
        principal.directoryId,
        requestId,
        principal.userKey,
        expectedRevision,
      )
      try {
        if (request.triageEntryId !== undefined) {
          const triage = dependencies.getTriage()
          if (!triage.listCustomerAssociations) {
            throw new CustomerError(
              503,
              'TriageCustomerAssociationUnavailable',
              'Triage Customer association is unavailable. Retry the request.',
            )
          }
          const associations = await triage.listCustomerAssociations(principal.directoryId, request.customerId)
          if (associations.some((entry) => entry.id === request.triageEntryId && entry.customerRequestId === request.id)) {
            throw new CustomerError(
              409,
              'CustomerRequestTriageAssociation',
              'A Customer Request associated with a Triage Entry cannot be deleted.',
            )
          }
        }
      } catch (error) {
        try {
          await customers.cancelCustomerRequestDeletion(
            principal.directoryId,
            requestId,
            principal.userKey,
            expectedRevision,
          )
        } catch (cancelError) {
          throw new CustomerError(
            503,
            'CustomerRequestMutationCancellationFailed',
            'The Customer Request deletion could not be safely prepared. Retry the operation.',
            { cause: cancelError },
          )
        }
        throw error
      }
      await customers.completeCustomerRequestDeletion(
        principal.directoryId,
        requestId,
        principal.userKey,
        expectedRevision,
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests/:requestId/merge', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const request = await dependencies.getCustomers().mergeRequest(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        readMergeRequestInput(await dependencies.readJson(context.req)),
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests/:requestId/work-items', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readLinkInput(await dependencies.readJson(context.req))
      const access = await dependencies.verifyWorkItemAccess(principal, body.teamId, body.workItemId, 'member')
      const request = await dependencies.getCustomers().linkRequestToWorkItem(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        { ...body, ...(access.projectId ? { projectId: access.projectId } : {}) },
        access.authorizationConditionChecks,
        access.isCompleted,
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId/work-items', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readUnlinkInput(await dependencies.readJson(context.req))
      const access = await dependencies.verifyWorkItemAccess(principal, body.teamId, body.workItemId, 'member')
      const request = await dependencies.getCustomers().unlinkRequestFromWorkItem(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
        access.authorizationConditionChecks,
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests/:requestId/projects', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readProjectLinkInput(await dependencies.readJson(context.req))
      const access = await dependencies.verifyProjectAccess(principal, body.projectId, 'member')
      const request = await dependencies.getCustomers().linkRequestToProject(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
        access.authorizationConditionChecks,
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId/projects', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readProjectUnlinkInput(await dependencies.readJson(context.req))
      const access = await dependencies.verifyProjectAccess(principal, body.projectId, 'member')
      const request = await dependencies.getCustomers().unlinkRequestFromProject(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
        access.authorizationConditionChecks,
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/teams/:teamId/triage-entries/:entryId/customer', async (context) => {
    try {
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const entryId = requirePathValue(context.req.param('entryId'), 'Triage Entry ID')
      const input = readTriageAssociationInput(await dependencies.readJson(context.req))
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage', { teamId })
      await dependencies.verifyTriageAccess(principal, teamId, 'member')
      const triage = dependencies.getTriage()
      const currentEntry = await triage.getEntry(principal.directoryId, teamId, entryId)
      const customerClient = dependencies.getCustomers()
      const effectiveCustomerId = input.customerId === undefined
        ? currentEntry.customerId
        : input.customerId
      if (effectiveCustomerId && effectiveCustomerId !== null) {
        const customer = await customerClient.getCustomer(principal.directoryId, effectiveCustomerId)
        if (input.contactId) {
          const contact = customer.contacts.find((candidate) => candidate.id === input.contactId)
          if (!contact) throw new CustomerError(404, 'CustomerContactNotFound', 'The customer contact was not found.')
          if (contact.status !== 'active') {
            throw new CustomerError(409, 'CustomerContactInactive', 'An inactive contact cannot be associated with a Triage Entry.')
          }
        }
        if (input.customerRequestId && !customer.requests.some((request) => request.id === input.customerRequestId)) {
          throw new CustomerError(404, 'CustomerRequestNotFound', 'The customer request was not found.')
        }
        if (input.customerRequestId) {
          const request = customer.requests.find((candidate) => candidate.id === input.customerRequestId)
          if (request?.triageEntryId !== entryId) {
            throw new CustomerError(409, 'CustomerRequestTriageMismatch', 'The Customer Request is not linked to this Triage Entry.')
          }
        }
      } else if (
        input.contactId !== undefined && input.contactId !== null ||
        input.customerRequestId !== undefined && input.customerRequestId !== null
      ) {
        throw new CustomerError(400, 'InvalidCustomerInput', 'A Customer is required when a Contact or Customer Request is associated.')
      }
      if (!triage.associateCustomer) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage Customer association is unavailable.')
      }
      const authorizationConditionChecks = await dependencies.createTriageAuthorizationConditionChecks(
        principal,
        teamId,
        [currentEntry.projectId],
      )
      const entry = await triage.associateCustomer(
        principal.directoryId,
        teamId,
        entryId,
        { id: principal.userKey },
        input,
        authorizationConditionChecks,
      )
      return context.json(projectTriageAssociation(entry))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/teams/:teamId/triage-entries/:entryId/customer-request', async (context) => {
    try {
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const entryId = requirePathValue(context.req.param('entryId'), 'Triage Entry ID')
      const input = readCreateRequestFromTriageInput(await dependencies.readJson(context.req))
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage', { teamId })
      await dependencies.verifyTriageAccess(principal, teamId, 'member')
      const triage = dependencies.getTriage()
      if (!triage.associateCustomer) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage Customer association is unavailable.')
      }
      const entry = await triage.getEntry(principal.directoryId, teamId, entryId)
      if (entry.state !== 'accepted') {
        throw new CustomerError(409, 'TriageEntryNotAccepted', 'Only an accepted Triage Entry can become a Customer Request.')
      }
      if (entry.permission.visibility !== 'full') {
        throw new CustomerError(403, 'TriageSourceUnavailable', 'Current source visibility does not allow creating a Customer Request.')
      }
      if (entry.revision !== input.expectedRevision) {
        throw new CustomerError(409, 'TriageRevisionConflict', 'The Triage Entry changed. Reload and try again.')
      }
      const contactId = input.contactId ?? entry.contactId
      const requestInput = createRequestInputFromTriage(entry, { ...input, ...(contactId ? { contactId } : {}) })
      if (entry.customerId && entry.customerId !== input.customerId) {
        throw new CustomerError(409, 'CustomerAlreadyAssociated', 'This Triage Entry is already associated with another Customer.')
      }
      if (entry.customerRequestId) {
        const existing = await dependencies.getCustomers().getRequest(principal.directoryId, entry.customerRequestId)
        if (existing.customerId !== input.customerId) {
          throw new CustomerError(409, 'CustomerRequestAlreadyAssociated', 'This Triage Entry is already associated with another Customer Request.')
        }
        if (existing.triageEntryId !== entryId) {
          throw new CustomerError(409, 'CustomerRequestTriageMismatch', 'The Customer Request is not linked to this Triage Entry.')
        }
        if (!isSameTriageRequestOrigin(existing, requestInput)) {
          throw new CustomerError(
            409,
            'CustomerRequestAssociationRecoveryRequired',
            'The existing Triage Customer Request no longer matches this Entry. Delete the orphaned Request after verifying the Triage association, then retry.',
          )
        }
        return context.json(await projectRequestForResponse(principal, existing, dependencies))
      }
      const canonicalWorkItem = entry.canonicalWorkItem
      if (canonicalWorkItem && canonicalWorkItem.teamId !== teamId) {
        throw new CustomerError(409, 'TriageWorkItemMismatch', 'The accepted Triage Entry points to a different Team Work Item.')
      }
      const workItemAuthorization = canonicalWorkItem
        ? await dependencies.verifyWorkItemAccess(
            principal,
            canonicalWorkItem.teamId,
            canonicalWorkItem.workItemId,
            'member',
          )
        : undefined
      const authorizationConditionChecks = await dependencies.createTriageAuthorizationConditionChecks(
        principal,
        teamId,
        [entry.projectId, workItemAuthorization?.projectId],
      )
      let request = await dependencies.getCustomers().createRequest(
        principal.directoryId,
        principal.userKey,
        requestInput,
        authorizationConditionChecks,
      )
      if (!isSameTriageRequestOrigin(request, requestInput)) {
        throw new CustomerError(
          409,
          'CustomerRequestAssociationRecoveryRequired',
          'The existing Triage Customer Request no longer matches this Entry. Delete the orphaned Request after verifying the Triage association, then retry.',
        )
      }
      if (canonicalWorkItem && workItemAuthorization) {
        request = await dependencies.getCustomers().linkRequestToWorkItem(
          principal.directoryId,
          request.id,
          principal.userKey,
          {
            teamId: canonicalWorkItem.teamId,
            workItemId: canonicalWorkItem.workItemId,
            ...(workItemAuthorization.projectId ? { projectId: workItemAuthorization.projectId } : {}),
          },
          workItemAuthorization.authorizationConditionChecks,
          workItemAuthorization.isCompleted,
        )
      }
      // The deterministic Triage-originated Request remains available for a safe retry if
      // this cross-store association returns an ambiguous failure.
      await triage.associateCustomer(
        principal.directoryId,
        teamId,
        entryId,
        { id: principal.userKey },
        {
          expectedRevision: entry.revision,
          customerId: input.customerId,
          ...(contactId ? { contactId } : {}),
          customerRequestId: request.id,
        },
        authorizationConditionChecks,
      )
      return context.json(await projectRequestForResponse(principal, request, dependencies), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/issues/:issueId/customer-impact', async (context) => {
    try {
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const issueId = requirePathValue(context.req.param('issueId'), 'Work Item ID')
      const principal = await dependencies.requireWorkspaceAccess(context, 'read', { teamId })
      await dependencies.verifyWorkItemAccess(principal, teamId, issueId, 'viewer')
      return context.json(projectCustomerImpact(principal, await dependencies.getCustomers().getWorkItemImpact(principal.directoryId, teamId, issueId)))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/projects/:projectId/customer-impact', async (context) => {
    try {
      const projectId = requirePathValue(context.req.param('projectId'), 'Project ID')
      const principal = await dependencies.requireWorkspaceAccess(context, 'read', { projectId })
      await dependencies.verifyProjectAccess(principal, projectId, 'viewer')
      /** Resolves a linked Work Item's current Project without exposing hidden relationships. */
      const resolveWorkItemProject: CustomerWorkItemProjectResolver = async (teamId, workItemId) => {
        try {
          return (await dependencies.verifyWorkItemAccess(principal, teamId, workItemId, 'viewer')).projectId
        } catch (error) {
          if (isHiddenCustomerRelationshipError(error)) return undefined
          throw error
        }
      }
      return context.json(projectCustomerImpact(
        principal,
        await dependencies.getCustomers().getProjectImpact(principal.directoryId, projectId, resolveWorkItemProject),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/** Projects internal Customer fields according to the current principal. */
function projectCustomer(principal: CustomerPrincipal, customer: Customer): Customer {
  if (principal.canViewSensitiveData) return customer
  return {
    ...customer,
    domain: undefined,
    ownerUserId: undefined,
    businessValue: undefined,
    notes: undefined,
  }
}

/** Projects a Customer impact signal according to the current principal. */
function projectCustomerImpact(principal: CustomerPrincipal, signal: CustomerImpactSignal): CustomerImpactSignal {
  return projectCustomerImpactSignal(signal, principal.canViewSensitiveData)
}

/** Rejects a Contact mutation while a Triage Entry still points at that Contact.
 *
 * @param workspaceId Workspace containing the Customer and Triage entries.
 * @param customerId Customer owning the Contact.
 * @param contactId Contact whose reverse links must be checked.
 * @param dependencies Triage dependency used to read reverse associations.
 * @returns A promise that resolves when the Contact has no Triage reverse link.
 */
async function assertContactMutationAllowed<Principal extends CustomerPrincipal>(
  workspaceId: string,
  customerId: string,
  contactId: string,
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'getTriage'>,
): Promise<void> {
  const triage = dependencies.getTriage()
  if (!triage.listCustomerAssociations) {
    throw new CustomerError(
      503,
      'TriageCustomerAssociationUnavailable',
      'Triage Customer association is unavailable. Retry the request.',
    )
  }
  const entries = await triage.listCustomerAssociations(workspaceId, customerId)
  if (entries.some((entry) => entry.contactId === contactId)) {
    throw new CustomerError(
      409,
      'CustomerContactTriageAssociation',
      'A Contact associated with a Triage Entry cannot be deleted or merged.',
    )
  }
}

/** Projects a saved Customer directory view according to the current principal. */
function projectSavedView(principal: CustomerPrincipal, view: CustomerSavedView): CustomerSavedView {
  if (principal.canViewSensitiveData) return view
  return {
    ...view,
    filters: projectCustomerFilters(principal, view.filters),
  }
}

/** Projects Customer filters without exposing business-value predicates to restricted readers. */
function projectCustomerFilters(principal: CustomerPrincipal, filters: CustomerListInput): CustomerListInput {
  if (principal.canViewSensitiveData) return filters
  const projected: CustomerListInput = { ...filters }
  delete projected.search
  delete projected.minBusinessValue
  if (projected.sortBy === 'businessValue') projected.sortBy = 'name'
  return projected
}

/** Projects internal Contact fields according to the current principal. */
function projectContact(principal: CustomerPrincipal, contact: CustomerContact): CustomerContact {
  if (principal.canViewSensitiveData) return contact
  return {
    ...contact,
    email: undefined,
    role: undefined,
    phone: undefined,
  }
}

/** Projects internal Customer Request fields according to the current principal. */
function projectRequest(principal: CustomerPrincipal, request: CustomerRequest): CustomerRequest {
  if (principal.canViewSensitiveData) return request
  return {
    ...request,
    source: { kind: request.source.kind, canNotify: false },
    originalMessage: '',
    externalReference: undefined,
  }
}

/** Projects Customer Request relationship links through live Team and Project authorization. */
async function projectRequestForResponse<Principal extends CustomerPrincipal>(
  principal: Principal,
  request: CustomerRequest,
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'verifyWorkItemAccess' | 'verifyProjectAccess'>,
): Promise<CustomerRequest> {
  const workItemLinks = (await Promise.all(request.workItemLinks.map(async (link) => {
    try {
      const access = await dependencies.verifyWorkItemAccess(
        principal,
        link.teamId,
        link.workItemId,
        'viewer',
      )
      const projectedLink = { ...link }
      if (access.projectId) {
        projectedLink.projectId = access.projectId
      } else {
        delete projectedLink.projectId
      }
      return projectedLink
    } catch (error) {
      if (isHiddenCustomerRelationshipError(error)) return undefined
      throw error
    }
  }))).flatMap((link) => link === undefined ? [] : [link])
  const projectLinks = (await Promise.all(request.projectLinks.map(async (link) => {
    try {
      await dependencies.verifyProjectAccess(principal, link.projectId, 'viewer')
      return link
    } catch (error) {
      if (isHiddenCustomerRelationshipError(error)) return undefined
      throw error
    }
  }))).flatMap((link) => link === undefined ? [] : [link])
  return projectRequest(principal, { ...request, workItemLinks, projectLinks })
}

/** Projects Customer Work Item summaries through live Work Item authorization. */
async function projectCustomerWorkItems<Principal extends CustomerPrincipal>(
  principal: Principal,
  workItems: readonly CustomerWorkItemSummary[],
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'verifyWorkItemAccess'>,
): Promise<CustomerWorkItemSummary[]> {
  return (await Promise.all(workItems.map(async (workItem) => {
    try {
      const access = await dependencies.verifyWorkItemAccess(
        principal,
        workItem.teamId,
        workItem.workItemId,
        'viewer',
      )
      const projectedWorkItem: CustomerWorkItemSummary = { ...workItem }
      if (access.projectId) {
        projectedWorkItem.projectId = access.projectId
      } else {
        delete projectedWorkItem.projectId
      }
      return projectedWorkItem
    } catch (error) {
      if (isHiddenCustomerRelationshipError(error)) return undefined
      throw error
    }
  }))).flatMap((workItem) => workItem === undefined ? [] : [workItem])
}

/** Projects Customer Project summaries through live Project authorization. */
async function projectCustomerProjects<Principal extends CustomerPrincipal>(
  principal: Principal,
  projects: CustomerDetail['projects'],
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'verifyProjectAccess'>,
): Promise<CustomerDetail['projects']> {
  return (await Promise.all(projects.map(async (project) => {
    try {
      await dependencies.verifyProjectAccess(principal, project.projectId, 'viewer')
      return project
    } catch (error) {
      if (isHiddenCustomerRelationshipError(error)) return undefined
      throw error
    }
  }))).flatMap((project) => project === undefined ? [] : [project])
}

/** Projects a complete Customer detail response. */
function projectDetail(principal: CustomerPrincipal, detail: CustomerDetail): CustomerDetail {
  return {
    customer: projectCustomer(principal, detail.customer),
    contacts: detail.contacts.map((contact) => projectContact(principal, contact)),
    requests: detail.requests.map((request) => projectRequest(principal, request)),
    workItems: detail.workItems,
    projects: detail.projects,
  }
}

/** Projects a committed Customer merge without rereading fallible relationship resources. */
function projectCommittedCustomerDetail(
  principal: CustomerPrincipal,
  detail: CustomerDetail,
): CustomerDetail {
  return projectDetail(principal, {
    ...detail,
    requests: detail.requests.map((request) => ({
      ...request,
      workItemLinks: [],
      projectLinks: [],
    })),
    workItems: [],
    projects: [],
  })
}

/** Projects a complete Customer detail after filtering every linked resource. */
async function projectCustomerDetail<Principal extends CustomerPrincipal>(
  principal: Principal,
  detail: CustomerDetail,
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'verifyWorkItemAccess' | 'verifyProjectAccess'>,
): Promise<CustomerDetail> {
  const requests = await Promise.all(detail.requests.map((request) =>
    projectRequestForResponse(principal, request, dependencies)
  ))
  const [workItems, projects] = await Promise.all([
    projectCustomerWorkItems(principal, detail.workItems, dependencies),
    projectCustomerProjects(principal, detail.projects, dependencies),
  ])
  return projectDetail(principal, { ...detail, requests, workItems, projects })
}

/** Projects an export while preserving the Workspace ownership boundary. */
async function projectExport<Principal extends CustomerPrincipal>(
  principal: Principal,
  value: CustomerWorkspaceExport,
  dependencies: Pick<CustomerRouterDependencies<Principal>, 'verifyWorkItemAccess' | 'verifyProjectAccess'>,
): Promise<CustomerWorkspaceExport> {
  return {
    ...value,
    customers: value.customers.map((customer) => projectCustomer(principal, customer)),
    contacts: value.contacts.map((contact) => projectContact(principal, contact)),
    requests: await Promise.all(value.requests.map((request) =>
      projectRequestForResponse(principal, request, dependencies)
    )),
  }
}

/** Projects the Customer fields carried in a Triage response. */
function projectTriageAssociation(entry: TriageEntry): Pick<TriageEntry, 'id' | 'teamId' | 'customerId' | 'contactId' | 'customerRequestId' | 'revision'> {
  return {
    id: entry.id,
    teamId: entry.teamId,
    ...(entry.customerId ? { customerId: entry.customerId } : {}),
    ...(entry.contactId ? { contactId: entry.contactId } : {}),
    ...(entry.customerRequestId ? { customerRequestId: entry.customerRequestId } : {}),
    revision: entry.revision,
  }
}

/** Reads customer list filters from query parameters. */
function readCustomerListInput(context: Context) {
  const search = readOptionalQuery(context, 'search')
  const tier = readOptionalEnum(context.req.query('tier'), ['strategic', 'enterprise', 'growth', 'standard', 'trial'] as const)
  const size = readOptionalEnum(context.req.query('size'), ['startup', 'small', 'mid-market', 'enterprise'] as const)
  const status = readOptionalEnum(context.req.query('status'), ['prospect', 'active', 'inactive', 'churned'] as const)
  const health = readOptionalEnum(context.req.query('health'), ['healthy', 'watch', 'at-risk', 'critical', 'unknown'] as const)
  const minBusinessValue = readOptionalBusinessValue(context.req.query('minBusinessValue'), 'Minimum business value')
  const minRequestCount = readOptionalNonnegativeInteger(context.req.query('minRequestCount'), 'Minimum request count')
  const sortBy = readOptionalEnum(context.req.query('sortBy'), ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt'] as const)
  const sortDirection = readOptionalEnum(context.req.query('sortDirection'), ['ascending', 'descending'] as const)
  const limit = readOptionalInteger(context.req.query('limit'), 'Customer page limit')
  const cursor = readOptionalQuery(context, 'cursor')
  return {
    ...(search ? { search } : {}),
    ...(tier ? { tier } : {}),
    ...(size ? { size } : {}),
    ...(status ? { status } : {}),
    ...(health ? { health } : {}),
    ...(minBusinessValue === undefined ? {} : { minBusinessValue }),
    ...(minRequestCount === undefined ? {} : { minRequestCount }),
    ...(sortBy ? { sortBy } : {}),
    ...(sortDirection ? { sortDirection } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
  }
}

/** Reads Customer Request list filters from query parameters. */
function readRequestListInput(context: Context) {
  return {
    ...(readOptionalQuery(context, 'customerId') ? { customerId: readOptionalQuery(context, 'customerId') } : {}),
    ...(readOptionalEnum(context.req.query('status'), ['requested', 'in-progress', 'completed', 'closed', 'merged'] as const) ? { status: readOptionalEnum(context.req.query('status'), ['requested', 'in-progress', 'completed', 'closed', 'merged'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('importance'), ['low', 'normal', 'high', 'urgent'] as const) ? { importance: readOptionalEnum(context.req.query('importance'), ['low', 'normal', 'high', 'urgent'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('sourceKind'), ['form', 'chat', 'email', 'webhook', 'manual-handoff', 'portal', 'phone', 'manual'] as const) ? { sourceKind: readOptionalEnum(context.req.query('sourceKind'), ['form', 'chat', 'email', 'webhook', 'manual-handoff', 'portal', 'phone', 'manual'] as const) } : {}),
    ...(readOptionalQuery(context, 'search') ? { search: readOptionalQuery(context, 'search') } : {}),
    ...(readOptionalInteger(context.req.query('limit'), 'Customer Request page limit') === undefined ? {} : { limit: readOptionalInteger(context.req.query('limit'), 'Customer Request page limit') }),
    ...(readOptionalQuery(context, 'cursor') ? { cursor: readOptionalQuery(context, 'cursor') } : {}),
  }
}

/** Reads a Customer creation body. */
function readCreateCustomerInput(value: unknown): CreateCustomerInput {
  const body = readRecord(value)
  return {
    name: readRequiredString(body.name, 'Customer name'),
    ...(readOptionalString(body.domain, 'Customer domain') ? { domain: readOptionalString(body.domain, 'Customer domain') } : {}),
    ...(readOptionalString(body.ownerUserId, 'Customer owner') ? { ownerUserId: readOptionalString(body.ownerUserId, 'Customer owner') } : {}),
    tier: readEnum(body.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial'], 'Customer tier'),
    size: readEnum(body.size, ['startup', 'small', 'mid-market', 'enterprise'], 'Customer size'),
    status: readEnum(body.status, ['prospect', 'active', 'inactive', 'churned'], 'Customer status'),
    health: readEnum(body.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown'], 'Customer health'),
    ...(body.businessValue === undefined ? {} : { businessValue: readNumber(body.businessValue, 'Business value') }),
    ...(body.notes === undefined ? {} : { notes: readNullableString(body.notes, 'Customer notes') ?? '' }),
    ...(readOptionalString(body.retentionExpiresAt, 'Customer retention deadline') ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt, 'Customer retention deadline') } : {}),
  }
}

/** Reads a Customer update body. */
function readUpdateCustomerInput(value: unknown): UpdateCustomerInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Customer revision'),
    ...(body.name === undefined ? {} : { name: readRequiredString(body.name, 'Customer name') }),
    ...(body.domain === undefined ? {} : { domain: readNullableString(body.domain, 'Customer domain') }),
    ...(body.ownerUserId === undefined ? {} : { ownerUserId: readNullableString(body.ownerUserId, 'Customer owner') }),
    ...(body.tier === undefined ? {} : { tier: readEnum(body.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial'], 'Customer tier') }),
    ...(body.size === undefined ? {} : { size: readEnum(body.size, ['startup', 'small', 'mid-market', 'enterprise'], 'Customer size') }),
    ...(body.status === undefined ? {} : { status: readEnum(body.status, ['prospect', 'active', 'inactive', 'churned'], 'Customer status') }),
    ...(body.health === undefined ? {} : { health: readEnum(body.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown'], 'Customer health') }),
    ...(body.businessValue === undefined ? {} : { businessValue: body.businessValue === null ? null : readNumber(body.businessValue, 'Business value') }),
    ...(body.notes === undefined ? {} : { notes: readNullableString(body.notes, 'Customer notes') }),
  }
}

/** Reads a Customer contact creation body. */
function readCreateContactInput(value: unknown): CreateCustomerContactInput {
  const body = readRecord(value)
  return {
    name: readRequiredString(body.name, 'Contact name'),
    ...(readOptionalString(body.email, 'Contact email') ? { email: readOptionalString(body.email, 'Contact email') } : {}),
    ...(readOptionalString(body.role, 'Contact role') ? { role: readOptionalString(body.role, 'Contact role') } : {}),
    ...(readOptionalString(body.phone, 'Contact phone') ? { phone: readOptionalString(body.phone, 'Contact phone') } : {}),
    ...(body.primary === undefined ? {} : { primary: readBoolean(body.primary, 'Contact primary flag') }),
    ...(readOptionalString(body.retentionExpiresAt, 'Contact retention deadline') ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt, 'Contact retention deadline') } : {}),
  }
}

/** Reads a Customer contact update body. */
function readUpdateContactInput(value: unknown): UpdateCustomerContactInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Contact revision'),
    ...(body.name === undefined ? {} : { name: readRequiredString(body.name, 'Contact name') }),
    ...(body.email === undefined ? {} : { email: readNullableString(body.email, 'Contact email') }),
    ...(body.role === undefined ? {} : { role: readNullableString(body.role, 'Contact role') }),
    ...(body.phone === undefined ? {} : { phone: readNullableString(body.phone, 'Contact phone') }),
    ...(body.primary === undefined ? {} : { primary: readBoolean(body.primary, 'Contact primary flag') }),
    ...(body.status === undefined ? {} : { status: readEnum(body.status, ['active', 'inactive'], 'Contact status') }),
  }
}

/** Reads a Customer Request creation body. */
function readCreateRequestInput(value: unknown, idempotencyKey: string): CreateCustomerRequestInput {
  const body = readRecord(value)
  if (Object.prototype.hasOwnProperty.call(body, 'triageEntryId')) {
    throw new CustomerError(400, 'CustomerTriageAssociationForbidden', 'Triage Entry associations must use the accepted Triage route.')
  }
  return {
    customerId: readRequiredString(body.customerId, 'Customer ID'),
    ...(readOptionalString(body.contactId, 'Contact ID') ? { contactId: readOptionalString(body.contactId, 'Contact ID') } : {}),
    idempotencyKey,
    source: readSource(body.source),
    originalMessage: readRequiredString(body.originalMessage, 'Customer Request message', true),
    receivedAt: readRequiredString(body.receivedAt, 'Customer Request received time'),
    importance: readEnum(body.importance, ['low', 'normal', 'high', 'urgent'], 'Customer Request importance'),
    ...(body.externalReference === undefined ? {} : { externalReference: readExternalReference(body.externalReference) }),
    ...(readOptionalString(body.retentionExpiresAt, 'Customer Request retention deadline') ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt, 'Customer Request retention deadline') } : {}),
  }
}

/** Reads the minimal input used to save an accepted Triage Entry as a Customer Request. */
function readCreateRequestFromTriageInput(value: unknown): CreateCustomerRequestFromTriageInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Triage revision'),
    customerId: readRequiredString(body.customerId, 'Customer ID'),
    ...(readOptionalString(body.contactId, 'Contact ID') ? { contactId: readOptionalString(body.contactId, 'Contact ID') } : {}),
    importance: readEnum(body.importance, ['low', 'normal', 'high', 'urgent'], 'Customer Request importance'),
  }
}

/** Builds a Customer Request from the permission-safe Triage source projection. */
function createRequestInputFromTriage(
  entry: TriageEntry,
  input: CreateCustomerRequestFromTriageInput,
): CreateCustomerRequestInput {
  const provider = entry.source.provider ?? entry.source.kind
  return {
    customerId: input.customerId,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    triageEntryId: entry.id,
    source: {
      kind: entry.source.kind,
      ...(entry.source.provider ? { provider: entry.source.provider } : {}),
      referenceId: entry.source.sourceId,
      ...(entry.sourcePreview.permalink ? { permalink: entry.sourcePreview.permalink } : {}),
      canNotify: entry.permission.canReply,
    },
    originalMessage: entry.sourcePreview.body,
    receivedAt: entry.receivedAt,
    importance: input.importance,
    externalReference: {
      provider,
      id: entry.source.sourceId,
      ...(entry.sourcePreview.permalink ? { permalink: entry.sourcePreview.permalink } : {}),
    },
    retentionExpiresAt: entry.retention.expiresAt,
  }
}

/** Checks whether a recovered Triage-originated Request still matches its source Entry. */
function isSameTriageRequestOrigin(
  request: CustomerRequest,
  input: CreateCustomerRequestInput,
): boolean {
  return request.customerId === input.customerId &&
    request.contactId === input.contactId &&
    request.triageEntryId === input.triageEntryId &&
    JSON.stringify(request.source) === JSON.stringify(input.source) &&
    request.originalMessage === input.originalMessage &&
    request.receivedAt === input.receivedAt &&
    request.importance === input.importance &&
    JSON.stringify(request.externalReference) === JSON.stringify(input.externalReference) &&
    request.retention?.expiresAt === input.retentionExpiresAt
}

/** Reads a Customer Request update body. */
function readUpdateRequestInput(value: unknown): UpdateCustomerRequestInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Customer Request revision'),
    ...(body.contactId === undefined ? {} : { contactId: readNullableString(body.contactId, 'Contact ID') }),
    ...(body.source === undefined ? {} : { source: readSource(body.source) }),
    ...(body.originalMessage === undefined ? {} : { originalMessage: readRequiredString(body.originalMessage, 'Customer Request message', true) }),
    ...(body.receivedAt === undefined ? {} : { receivedAt: readRequiredString(body.receivedAt, 'Customer Request received time') }),
    ...(body.importance === undefined ? {} : { importance: readEnum(body.importance, ['low', 'normal', 'high', 'urgent'], 'Customer Request importance') }),
    ...(body.externalReference === undefined ? {} : { externalReference: body.externalReference === null ? null : readExternalReference(body.externalReference) }),
    ...(body.status === undefined ? {} : { status: readEnum(body.status, ['requested', 'in-progress', 'completed', 'closed', 'merged'], 'Customer Request status') }),
  }
}

/** Reads source metadata from a Customer Request body. */
function readSource(value: unknown): CustomerRequestSource {
  const source = readRecord(value)
  return {
    kind: readEnum(source.kind, ['form', 'chat', 'email', 'webhook', 'manual-handoff', 'portal', 'phone', 'manual'], 'Request source kind'),
    ...(readOptionalString(source.provider, 'Request source provider') ? { provider: readOptionalString(source.provider, 'Request source provider') } : {}),
    ...(readOptionalString(source.referenceId, 'Request source reference') ? { referenceId: readOptionalString(source.referenceId, 'Request source reference') } : {}),
    ...(readOptionalString(source.permalink, 'Request source permalink') ? { permalink: readOptionalString(source.permalink, 'Request source permalink') } : {}),
    canNotify: source.canNotify === undefined ? false : readBoolean(source.canNotify, 'Request source notification capability'),
  }
}

/** Reads an external Customer Request reference. */
function readExternalReference(value: unknown) {
  const reference = readRecord(value)
  return {
    provider: readRequiredString(reference.provider, 'External reference provider'),
    id: readRequiredString(reference.id, 'External reference ID'),
    ...(readOptionalString(reference.permalink, 'External reference permalink') ? { permalink: readOptionalString(reference.permalink, 'External reference permalink') } : {}),
  }
}

/** Reads a Work Item link body. */
function readLinkInput(value: unknown): LinkCustomerRequestWorkItemInput {
  const body = readRecord(value)
  return {
    teamId: readRequiredString(body.teamId, 'Team ID'),
    workItemId: readRequiredString(body.workItemId, 'Work Item ID'),
  }
}

/** Reads a direct Customer Request-to-Project link body. */
function readProjectLinkInput(value: unknown): LinkCustomerRequestProjectInput {
  const body = readRecord(value)
  return { projectId: readRequiredString(body.projectId, 'Project ID') }
}

/** Reads a direct Customer Request-to-Project unlink body. */
function readProjectUnlinkInput(value: unknown): LinkCustomerRequestProjectInput & { expectedRevision: number } {
  return {
    ...readProjectLinkInput(value),
    expectedRevision: readInteger(readRecord(value).expectedRevision, 'Customer Request revision'),
  }
}

/** Reads a Work Item unlink body. */
function readUnlinkInput(value: unknown): LinkCustomerRequestWorkItemInput & { expectedRevision: number } {
  return {
    ...readLinkInput(value),
    expectedRevision: readInteger(readRecord(value).expectedRevision, 'Customer Request revision'),
  }
}

/** Reads a Customer merge body. */
function readMergeCustomerInput(value: unknown): MergeCustomerInput {
  const body = readRecord(value)
  return {
    targetCustomerId: readRequiredString(body.targetCustomerId, 'Target customer ID'),
    sourceExpectedRevision: readInteger(body.sourceExpectedRevision, 'Source customer revision'),
    targetExpectedRevision: readInteger(body.targetExpectedRevision, 'Target customer revision'),
  }
}

/** Reads a Contact merge body. */
function readMergeContactInput(value: unknown): MergeCustomerContactInput {
  const body = readRecord(value)
  return {
    targetContactId: readRequiredString(body.targetContactId, 'Target contact ID'),
    sourceExpectedRevision: readInteger(body.sourceExpectedRevision, 'Source contact revision'),
    targetExpectedRevision: readInteger(body.targetExpectedRevision, 'Target contact revision'),
  }
}

/** Reads a Customer Request merge body. */
function readMergeRequestInput(value: unknown): MergeCustomerRequestInput {
  const body = readRecord(value)
  return {
    targetRequestId: readRequiredString(body.targetRequestId, 'Target Customer Request ID'),
    sourceExpectedRevision: readInteger(body.sourceExpectedRevision, 'Source Customer Request revision'),
    targetExpectedRevision: readInteger(body.targetExpectedRevision, 'Target Customer Request revision'),
  }
}

/** Reads a Triage Customer association body. */
function readTriageAssociationInput(value: unknown): UpdateTriageCustomerAssociationInput {
  const body = readRecord(value)
  const customerId = body.customerId === undefined
    ? undefined
    : body.customerId === null
      ? null
      : readRequiredString(body.customerId, 'Customer ID')
  const contactId = body.contactId === undefined
    ? undefined
    : readNullableString(body.contactId, 'Contact ID')
  const customerRequestId = body.customerRequestId === undefined
    ? undefined
    : readNullableString(body.customerRequestId, 'Customer Request ID')
  if (customerId === null && (
    contactId !== undefined && contactId !== null ||
    customerRequestId !== undefined && customerRequestId !== null
  )) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'A Customer is required when a Contact or Customer Request is associated.')
  }
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Triage revision'),
    customerId,
    ...(contactId === undefined ? {} : { contactId }),
    ...(customerRequestId === undefined ? {} : { customerRequestId }),
  }
}

/** Reads a saved-view creation body. */
function readCreateSavedViewInput(value: unknown): CreateCustomerSavedViewInput {
  const body = readRecord(value)
  return {
    name: readRequiredString(body.name, 'Saved view name'),
    filters: readCustomerFilterRecord(body.filters),
    ...(body.groupBy === undefined ? {} : { groupBy: readEnum(body.groupBy, ['tier', 'size', 'status', 'health', 'owner'], 'Saved view grouping') }),
  }
}

/** Reads a saved-view update body. */
function readUpdateSavedViewInput(value: unknown): UpdateCustomerSavedViewInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Saved view revision'),
    ...(body.name === undefined ? {} : { name: readRequiredString(body.name, 'Saved view name') }),
    ...(body.filters === undefined ? {} : { filters: readCustomerFilterRecord(body.filters) }),
    ...(body.groupBy === undefined ? {} : { groupBy: body.groupBy === null ? null : readEnum(body.groupBy, ['tier', 'size', 'status', 'health', 'owner'], 'Saved view grouping') }),
  }
}

/** Reads a saved-view filter object while preserving only supported fields. */
function readCustomerFilterRecord(value: unknown) {
  const record = readRecord(value)
  return {
    ...(readOptionalString(record.search, 'Customer search') ? { search: readOptionalString(record.search, 'Customer search') } : {}),
    ...(record.tier === undefined ? {} : { tier: readEnum(record.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial'], 'Customer tier') }),
    ...(record.size === undefined ? {} : { size: readEnum(record.size, ['startup', 'small', 'mid-market', 'enterprise'], 'Customer size') }),
    ...(record.status === undefined ? {} : { status: readEnum(record.status, ['prospect', 'active', 'inactive', 'churned'], 'Customer status') }),
    ...(record.health === undefined ? {} : { health: readEnum(record.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown'], 'Customer health') }),
    ...(record.minBusinessValue === undefined ? {} : { minBusinessValue: readBusinessValue(record.minBusinessValue, 'Minimum business value') }),
    ...(record.minRequestCount === undefined ? {} : { minRequestCount: readNonnegativeInteger(record.minRequestCount, 'Minimum request count') }),
    ...(record.sortBy === undefined ? {} : { sortBy: readEnum(record.sortBy, ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt'], 'Customer sort field') }),
    ...(record.sortDirection === undefined ? {} : { sortDirection: readEnum(record.sortDirection, ['ascending', 'descending'], 'Customer sort direction') }),
    ...(record.limit === undefined ? {} : { limit: readInteger(record.limit, 'Customer page limit') }),
  }
}

/** Reads a path segment. */
function requirePathValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is required.`)
  return value
}

/** Reads a required string body field. */
function readRequiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads an optional string body field without silently dropping malformed values.
 *
 * @param value Untrusted body field.
 * @param label Human-readable field label for validation errors.
 * @returns The original non-blank string, or undefined when the field is absent or blank.
 * @throws CustomerError when a present value is not a string.
 */
function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value.trim() ? value : undefined
}

/** Reads a nullable string body field. */
function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads a boolean body field. */
function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads a finite number body field. */
function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads a Customer business-value score in its inclusive persisted range. */
function readBusinessValue(value: unknown, label: string): number {
  const number = readNumber(value, label)
  if (number < 0 || number > 100) {
    throw new CustomerError(400, 'InvalidCustomerInput', `${label} must be between 0 and 100.`)
  }
  return number
}

/** Reads an integer body field. */
function readInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads a nonnegative integer body field. */
function readNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads an optional Customer business-value score from a query parameter. */
function readOptionalBusinessValue(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return readBusinessValue(Number(value), label)
}

/** Reads an optional query integer. */
function readOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return readInteger(Number(value), label)
}

/** Reads an optional nonnegative query integer. */
function readOptionalNonnegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return readNonnegativeInteger(Number(value), label)
}

/** Reads a string enum. */
function readEnum<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new CustomerError(400, 'InvalidCustomerInput', `${label} is invalid.`)
  return value
}

/** Reads an optional query enum. */
function readOptionalEnum<const Values extends readonly string[]>(value: string | undefined, values: Values): Values[number] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return readEnum(value, values, 'Customer query filter')
}

/** Reads an optional query parameter. */
function readOptionalQuery(context: Context, name: string): string | undefined {
  const value = context.req.query(name)?.trim()
  return value || undefined
}

/** Reads a positive expected revision query parameter. */
function readExpectedRevision(value: string | undefined): number {
  return readInteger(value === undefined ? undefined : Number(value), 'Expected revision')
}

/** Rejects filters that would require scanning or ordering by fields hidden from a restricted reader.
 *
 * @param principal Authenticated Customer route principal.
 * @param input Customer directory filters supplied by the caller.
 * @throws CustomerError when a restricted principal supplies a sensitive filter.
 */
function requireRestrictedCustomerFilters(
  principal: CustomerPrincipal,
  input: Pick<CustomerListInput, 'search' | 'minBusinessValue' | 'sortBy'>,
): void {
  if (principal.canViewSensitiveData) return
  if (!input.search && input.minBusinessValue === undefined && input.sortBy !== 'businessValue') return
  throw new CustomerError(
    403,
    'CustomerSearchRestricted',
    'Customer search and business-value filters require Customer management access.',
  )
}

/** Rejects request searches that would require scanning hidden source content. */
function requireRestrictedSearch(principal: CustomerPrincipal, search: string | undefined): void {
  requireRestrictedCustomerFilters(principal, { search })
}

/** Reads the caller-selected key required for generic Customer Request creation.
 *
 * @param value Idempotency-Key header value.
 * @returns A trimmed, bounded retry key.
 * @throws CustomerError when the header is missing or invalid.
 */
function readIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim()
  if (!normalized || normalized.length > 256 || [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) {
    throw new CustomerError(400, 'InvalidCustomerInput', 'Idempotency-Key is required and invalid.')
  }
  return normalized
}

/** Reads an object body. */
function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CustomerError(400, 'InvalidCustomerInput', 'A JSON object body is required.')
  return value
}

/** Identifies authorization and not-found errors that hide a relationship. */
function isHiddenCustomerRelationshipError(value: unknown): boolean {
  return isRecord(value) && (value.status === 403 || value.status === 404)
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
