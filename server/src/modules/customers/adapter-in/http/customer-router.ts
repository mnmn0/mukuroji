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
  CustomerRequest,
  CustomerRequestSource,
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
} from '../../domain/customer'
import type { CustomerClient } from '../../customers'
import type { TriageClient } from '../../../triage'

/** Minimum authenticated Workspace identity required by Customer routes. */
export type CustomerPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Stable authenticated actor identifier. */
  userKey: string
  /** Whether internal Customer attributes and request content may be returned. */
  canViewSensitiveData: boolean
}

/** Result of resolving a Work Item for a Customer Request link. */
export type CustomerWorkItemAuthorization = {
  /** Project assigned to the Work Item, when available. */
  projectId?: string
}

/** Dependencies injected into the Customer HTTP adapter. */
export type CustomerRouterDependencies<Principal extends CustomerPrincipal = CustomerPrincipal> = {
  /** Returns the Customer application client. */
  getCustomers(): CustomerClient
  /** Authenticates and authorizes the current Workspace request. */
  requireWorkspaceAccess(context: Context, minimum: 'read' | 'write' | 'manage'): Promise<Principal>
  /** Verifies Team access before associating a Triage Entry. */
  verifyTriageAccess(principal: Principal, teamId: string, minimum: 'viewer' | 'member'): Promise<void>
  /** Resolves and authorizes a Work Item before creating a customer link. */
  verifyWorkItemAccess(principal: Principal, teamId: string, workItemId: string, minimum: 'viewer' | 'member'): Promise<CustomerWorkItemAuthorization>
  /** Resolves and authorizes a Project before reading or mutating its associations. */
  verifyProjectAccess(principal: Principal, projectId: string, minimum: 'viewer' | 'member'): Promise<void>
  /** Returns the Triage operations used for Customer associations. */
  getTriage(): Pick<TriageClient, 'getEntry' | 'associateCustomer'>
  /** Safely parses a JSON request body. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Maps Customer, authentication, authorization, and persistence failures to HTTP. */
  mapError(context: Context, error: unknown): Response
}

/** Creates Workspace-scoped Customer directory, request, impact, and lifecycle routes. */
export function createCustomerRouter<Principal extends CustomerPrincipal = CustomerPrincipal>(dependencies: CustomerRouterDependencies<Principal>): Hono {
  const router = new Hono()

  router.get('/api/customers/export', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      return context.json(projectExport(principal, await dependencies.getCustomers().exportWorkspace(principal.directoryId)))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/report', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const page = await dependencies.getCustomers().listCustomers(
        principal.directoryId,
        readCustomerListInput(context),
      )
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
      return context.json({ views: await dependencies.getCustomers().listSavedViews(principal.directoryId) })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers/views', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      return context.json(await dependencies.getCustomers().createSavedView(
        principal.directoryId,
        principal.userKey,
        readCreateSavedViewInput(await dependencies.readJson(context.req)),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/views/:viewId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      return context.json(await dependencies.getCustomers().updateSavedView(
        principal.directoryId,
        context.req.param('viewId') ?? '',
        principal.userKey,
        readUpdateSavedViewInput(await dependencies.readJson(context.req)),
      ))
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
      const page = await dependencies.getCustomers().listCustomers(
        principal.directoryId,
        readCustomerListInput(context),
      )
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
      return context.json(await dependencies.getCustomers().createCustomer(
        principal.directoryId,
        principal.userKey,
        readCreateCustomerInput(await dependencies.readJson(context.req)),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/:customerId/work-items', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json({
        workItems: await dependencies.getCustomers().listCustomerWorkItems(
          principal.directoryId,
          context.req.param('customerId') ?? '',
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
      return context.json(await dependencies.getCustomers().createContact(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        readCreateContactInput(await dependencies.readJson(context.req)),
      ), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json(projectDetail(principal, await dependencies.getCustomers().getCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
      )))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      return context.json(await dependencies.getCustomers().updateCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        readUpdateCustomerInput(await dependencies.readJson(context.req)),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customers/:customerId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      await dependencies.getCustomers().deleteCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        readExpectedRevision(context.req.query('expectedRevision')),
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customers/:customerId/merge', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      const detail = await dependencies.getCustomers().mergeCustomer(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        principal.userKey,
        readMergeCustomerInput(await dependencies.readJson(context.req)),
      )
      return context.json(projectDetail(principal, detail))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.patch('/api/customers/:customerId/contacts/:contactId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      return context.json(await dependencies.getCustomers().updateContact(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        context.req.param('contactId') ?? '',
        principal.userKey,
        readUpdateContactInput(await dependencies.readJson(context.req)),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customers/:customerId/contacts/:contactId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      await dependencies.getCustomers().deleteContact(
        principal.directoryId,
        context.req.param('customerId') ?? '',
        context.req.param('contactId') ?? '',
        principal.userKey,
        readExpectedRevision(context.req.query('expectedRevision')),
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-contacts/:contactId/merge', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      return context.json(await dependencies.getCustomers().mergeContact(
        principal.directoryId,
        context.req.param('contactId') ?? '',
        principal.userKey,
        readMergeContactInput(await dependencies.readJson(context.req)),
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customer-requests', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const page = await dependencies.getCustomers().listRequests(
        principal.directoryId,
        readRequestListInput(context),
      )
      return context.json({
        ...page,
        requests: page.requests.map((request) => projectRequest(principal, request)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const request = await dependencies.getCustomers().createRequest(
        principal.directoryId,
        principal.userKey,
        readCreateRequestInput(await dependencies.readJson(context.req)),
      )
      return context.json(projectRequest(principal, request), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/customer-requests/:requestId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      return context.json(projectRequest(principal, await dependencies.getCustomers().getRequest(
        principal.directoryId,
        context.req.param('requestId') ?? '',
      )))
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
      return context.json(projectRequest(principal, request))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'manage')
      await dependencies.getCustomers().deleteRequest(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        readExpectedRevision(context.req.query('expectedRevision')),
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
      return context.json(projectRequest(principal, request))
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
      )
      return context.json(projectRequest(principal, request))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId/work-items', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readUnlinkInput(await dependencies.readJson(context.req))
      await dependencies.verifyWorkItemAccess(principal, body.teamId, body.workItemId, 'member')
      const request = await dependencies.getCustomers().unlinkRequestFromWorkItem(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
      )
      return context.json(projectRequest(principal, request))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/customer-requests/:requestId/projects', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readProjectLinkInput(await dependencies.readJson(context.req))
      await dependencies.verifyProjectAccess(principal, body.projectId, 'member')
      const request = await dependencies.getCustomers().linkRequestToProject(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
      )
      return context.json(projectRequest(principal, request))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/customer-requests/:requestId/projects', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const body = readProjectUnlinkInput(await dependencies.readJson(context.req))
      await dependencies.verifyProjectAccess(principal, body.projectId, 'member')
      const request = await dependencies.getCustomers().unlinkRequestFromProject(
        principal.directoryId,
        context.req.param('requestId') ?? '',
        principal.userKey,
        body,
      )
      return context.json(projectRequest(principal, request))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/teams/:teamId/triage-entries/:entryId/customer', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const entryId = requirePathValue(context.req.param('entryId'), 'Triage Entry ID')
      const input = readTriageAssociationInput(await dependencies.readJson(context.req))
      await dependencies.verifyTriageAccess(principal, teamId, 'member')
      const triage = dependencies.getTriage()
      const currentEntry = await triage.getEntry(principal.directoryId, teamId, entryId)
      const customerClient = dependencies.getCustomers()
      const effectiveCustomerId = input.customerId === undefined
        ? currentEntry.customerId
        : input.customerId
      if (effectiveCustomerId && effectiveCustomerId !== null) {
        const customer = await customerClient.getCustomer(principal.directoryId, effectiveCustomerId)
        if (input.contactId && !customer.contacts.some((contact) => contact.id === input.contactId)) {
          throw new CustomerError(404, 'CustomerContactNotFound', 'The customer contact was not found.')
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
      } else if (input.contactId !== undefined || input.customerRequestId !== undefined) {
        throw new CustomerError(400, 'InvalidCustomerInput', 'A Customer is required when a Contact or Customer Request is associated.')
      }
      if (!triage.associateCustomer) {
        throw new CustomerError(503, 'TriageCustomerAssociationUnavailable', 'Triage Customer association is unavailable.')
      }
      const entry = await triage.associateCustomer(
        principal.directoryId,
        teamId,
        entryId,
        { id: principal.userKey },
        input,
      )
      return context.json(projectTriageAssociation(entry))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/teams/:teamId/triage-entries/:entryId/customer-request', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'write')
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const entryId = requirePathValue(context.req.param('entryId'), 'Triage Entry ID')
      const input = readCreateRequestFromTriageInput(await dependencies.readJson(context.req))
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
      if (entry.customerRequestId) {
        const existing = await dependencies.getCustomers().getRequest(principal.directoryId, entry.customerRequestId)
        if (existing.customerId !== input.customerId) {
          throw new CustomerError(409, 'CustomerRequestAlreadyAssociated', 'This Triage Entry is already associated with another Customer Request.')
        }
        if (existing.triageEntryId !== entryId) {
          throw new CustomerError(409, 'CustomerRequestTriageMismatch', 'The Customer Request is not linked to this Triage Entry.')
        }
        return context.json(projectRequest(principal, existing))
      }
      if (entry.customerId && entry.customerId !== input.customerId) {
        throw new CustomerError(409, 'CustomerAlreadyAssociated', 'This Triage Entry is already associated with another Customer.')
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
      const customer = await dependencies.getCustomers().getCustomer(principal.directoryId, input.customerId)
      const contactId = input.contactId ?? entry.contactId
      if (contactId && !customer.contacts.some((contact) => contact.id === contactId)) {
        throw new CustomerError(404, 'CustomerContactNotFound', 'The customer contact was not found.')
      }
      let request = await dependencies.getCustomers().createRequest(
        principal.directoryId,
        principal.userKey,
        createRequestInputFromTriage(entry, { ...input, ...(contactId ? { contactId } : {}) }),
      )
      try {
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
          )
        }
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
        )
      } catch (error) {
        await dependencies.getCustomers().deleteRequest(
          principal.directoryId,
          request.id,
          principal.userKey,
          request.revision,
        ).catch(() => undefined)
        throw error
      }
      return context.json(projectRequest(principal, request), 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/issues/:issueId/customer-impact', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const teamId = requirePathValue(context.req.param('teamId'), 'Team ID')
      const issueId = requirePathValue(context.req.param('issueId'), 'Work Item ID')
      await dependencies.verifyWorkItemAccess(principal, teamId, issueId, 'viewer')
      return context.json(await dependencies.getCustomers().getWorkItemImpact(principal.directoryId, teamId, issueId))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/projects/:projectId/customer-impact', async (context) => {
    try {
      const principal = await dependencies.requireWorkspaceAccess(context, 'read')
      const projectId = requirePathValue(context.req.param('projectId'), 'Project ID')
      await dependencies.verifyProjectAccess(principal, projectId, 'viewer')
      return context.json(await dependencies.getCustomers().getProjectImpact(principal.directoryId, projectId))
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

/** Projects an export while preserving the Workspace ownership boundary. */
function projectExport(principal: CustomerPrincipal, value: CustomerWorkspaceExport): CustomerWorkspaceExport {
  return {
    ...value,
    customers: value.customers.map((customer) => projectCustomer(principal, customer)),
    contacts: value.contacts.map((contact) => projectContact(principal, contact)),
    requests: value.requests.map((request) => projectRequest(principal, request)),
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
  return {
    ...(readOptionalQuery(context, 'search') ? { search: readOptionalQuery(context, 'search') } : {}),
    ...(readOptionalEnum(context.req.query('tier'), ['strategic', 'enterprise', 'growth', 'standard', 'trial'] as const) ? { tier: readOptionalEnum(context.req.query('tier'), ['strategic', 'enterprise', 'growth', 'standard', 'trial'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('size'), ['startup', 'small', 'mid-market', 'enterprise'] as const) ? { size: readOptionalEnum(context.req.query('size'), ['startup', 'small', 'mid-market', 'enterprise'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('status'), ['prospect', 'active', 'inactive', 'churned'] as const) ? { status: readOptionalEnum(context.req.query('status'), ['prospect', 'active', 'inactive', 'churned'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('health'), ['healthy', 'watch', 'at-risk', 'critical', 'unknown'] as const) ? { health: readOptionalEnum(context.req.query('health'), ['healthy', 'watch', 'at-risk', 'critical', 'unknown'] as const) } : {}),
    ...(readOptionalNumber(context.req.query('minBusinessValue'), 'Minimum business value') === undefined ? {} : { minBusinessValue: readOptionalNumber(context.req.query('minBusinessValue'), 'Minimum business value') }),
    ...(readOptionalNonnegativeInteger(context.req.query('minRequestCount'), 'Minimum request count') === undefined ? {} : { minRequestCount: readOptionalNonnegativeInteger(context.req.query('minRequestCount'), 'Minimum request count') }),
    ...(readOptionalEnum(context.req.query('sortBy'), ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt'] as const) ? { sortBy: readOptionalEnum(context.req.query('sortBy'), ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt'] as const) } : {}),
    ...(readOptionalEnum(context.req.query('sortDirection'), ['ascending', 'descending'] as const) ? { sortDirection: readOptionalEnum(context.req.query('sortDirection'), ['ascending', 'descending'] as const) } : {}),
    ...(readOptionalInteger(context.req.query('limit'), 'Customer page limit') === undefined ? {} : { limit: readOptionalInteger(context.req.query('limit'), 'Customer page limit') }),
    ...(readOptionalQuery(context, 'cursor') ? { cursor: readOptionalQuery(context, 'cursor') } : {}),
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
    ...(readOptionalString(body.domain) ? { domain: readOptionalString(body.domain) } : {}),
    ...(readOptionalString(body.ownerUserId) ? { ownerUserId: readOptionalString(body.ownerUserId) } : {}),
    tier: readEnum(body.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial'], 'Customer tier'),
    size: readEnum(body.size, ['startup', 'small', 'mid-market', 'enterprise'], 'Customer size'),
    status: readEnum(body.status, ['prospect', 'active', 'inactive', 'churned'], 'Customer status'),
    health: readEnum(body.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown'], 'Customer health'),
    ...(body.businessValue === undefined ? {} : { businessValue: readNumber(body.businessValue, 'Business value') }),
    ...(body.notes === undefined ? {} : { notes: readNullableString(body.notes, 'Customer notes') ?? '' }),
    ...(readOptionalString(body.retentionExpiresAt) ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt) } : {}),
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
    ...(readOptionalString(body.email) ? { email: readOptionalString(body.email) } : {}),
    ...(readOptionalString(body.role) ? { role: readOptionalString(body.role) } : {}),
    ...(readOptionalString(body.phone) ? { phone: readOptionalString(body.phone) } : {}),
    ...(body.primary === undefined ? {} : { primary: readBoolean(body.primary, 'Contact primary flag') }),
    ...(readOptionalString(body.retentionExpiresAt) ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt) } : {}),
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
function readCreateRequestInput(value: unknown): CreateCustomerRequestInput {
  const body = readRecord(value)
  return {
    customerId: readRequiredString(body.customerId, 'Customer ID'),
    ...(readOptionalString(body.contactId) ? { contactId: readOptionalString(body.contactId) } : {}),
    ...(readOptionalString(body.triageEntryId) ? { triageEntryId: readOptionalString(body.triageEntryId) } : {}),
    source: readSource(body.source),
    originalMessage: readRequiredString(body.originalMessage, 'Customer Request message', true),
    receivedAt: readRequiredString(body.receivedAt, 'Customer Request received time'),
    importance: readEnum(body.importance, ['low', 'normal', 'high', 'urgent'], 'Customer Request importance'),
    ...(body.externalReference === undefined ? {} : { externalReference: readExternalReference(body.externalReference) }),
    ...(readOptionalString(body.retentionExpiresAt) ? { retentionExpiresAt: readOptionalString(body.retentionExpiresAt) } : {}),
  }
}

/** Reads the minimal input used to save an accepted Triage Entry as a Customer Request. */
function readCreateRequestFromTriageInput(value: unknown): CreateCustomerRequestFromTriageInput {
  const body = readRecord(value)
  return {
    expectedRevision: readInteger(body.expectedRevision, 'Triage revision'),
    customerId: readRequiredString(body.customerId, 'Customer ID'),
    ...(readOptionalString(body.contactId) ? { contactId: readOptionalString(body.contactId) } : {}),
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
    ...(readOptionalString(source.provider) ? { provider: readOptionalString(source.provider) } : {}),
    ...(readOptionalString(source.referenceId) ? { referenceId: readOptionalString(source.referenceId) } : {}),
    ...(readOptionalString(source.permalink) ? { permalink: readOptionalString(source.permalink) } : {}),
    canNotify: source.canNotify === undefined ? false : readBoolean(source.canNotify, 'Request source notification capability'),
  }
}

/** Reads an external Customer Request reference. */
function readExternalReference(value: unknown) {
  const reference = readRecord(value)
  return {
    provider: readRequiredString(reference.provider, 'External reference provider'),
    id: readRequiredString(reference.id, 'External reference ID'),
    ...(readOptionalString(reference.permalink) ? { permalink: readOptionalString(reference.permalink) } : {}),
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
  if (customerId === null && (contactId !== undefined || customerRequestId !== undefined)) {
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
    ...(readOptionalString(record.search) ? { search: readOptionalString(record.search) } : {}),
    ...(record.tier === undefined ? {} : { tier: readEnum(record.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial'], 'Customer tier') }),
    ...(record.size === undefined ? {} : { size: readEnum(record.size, ['startup', 'small', 'mid-market', 'enterprise'], 'Customer size') }),
    ...(record.status === undefined ? {} : { status: readEnum(record.status, ['prospect', 'active', 'inactive', 'churned'], 'Customer status') }),
    ...(record.health === undefined ? {} : { health: readEnum(record.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown'], 'Customer health') }),
    ...(record.minBusinessValue === undefined ? {} : { minBusinessValue: readNumber(record.minBusinessValue, 'Minimum business value') }),
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

/** Reads an optional string body field. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
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

/** Reads an optional query number. */
function readOptionalNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return readNumber(Number(value), label)
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

/** Reads an object body. */
function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CustomerError(400, 'InvalidCustomerInput', 'A JSON object body is required.')
  return value
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
