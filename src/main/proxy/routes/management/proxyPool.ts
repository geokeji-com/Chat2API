import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyPoolManager } from '../../proxyPool'
import type { ManagementApiResponse, ProxyNode } from '../../../../../shared/types'

const router = new Router({ prefix: '/v0/management/proxy-pool' })

router.use(managementAuthMiddleware)

function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return { success: true, data }
}

function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: { code, message },
  }
}

function handleError(ctx: Context, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : fallback
  ctx.status = message.includes('not found') ? 404 : 400
  ctx.body = createErrorResponse(ctx.status === 404 ? 'not_found' : 'invalid_request', message)
}

router.get('/nodes', async (ctx: Context) => {
  try {
    ctx.body = createSuccessResponse(proxyPoolManager.getAll(false))
  } catch (error) {
    handleError(ctx, error, 'Failed to get proxy nodes')
  }
})

router.post('/nodes', async (ctx: Context) => {
  try {
    const node = proxyPoolManager.create(ctx.request.body as {
      name: string
      host: string
      port: number
      username?: string
      password?: string
      province?: string
      city?: string
      regionCode?: string
      enabled?: boolean
    })
    ctx.status = 201
    ctx.body = createSuccessResponse(node)
  } catch (error) {
    handleError(ctx, error, 'Failed to create proxy node')
  }
})

router.get('/nodes/:id', async (ctx: Context) => {
  try {
    const node = proxyPoolManager.getById(ctx.params.id, false)
    if (!node) {
      ctx.status = 404
      ctx.body = createErrorResponse('proxy_node_not_found', `Proxy node not found: ${ctx.params.id}`)
      return
    }
    ctx.body = createSuccessResponse(node)
  } catch (error) {
    handleError(ctx, error, 'Failed to get proxy node')
  }
})

router.put('/nodes/:id', async (ctx: Context) => {
  try {
    const node = proxyPoolManager.update(ctx.params.id, ctx.request.body as Partial<ProxyNode>)
    if (!node) {
      ctx.status = 404
      ctx.body = createErrorResponse('proxy_node_not_found', `Proxy node not found: ${ctx.params.id}`)
      return
    }
    ctx.body = createSuccessResponse(node)
  } catch (error) {
    handleError(ctx, error, 'Failed to update proxy node')
  }
})

router.delete('/nodes/:id', async (ctx: Context) => {
  try {
    const deleted = proxyPoolManager.delete(ctx.params.id)
    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('proxy_node_not_found', `Proxy node not found: ${ctx.params.id}`)
      return
    }
    ctx.body = createSuccessResponse({ id: ctx.params.id, deleted: true })
  } catch (error) {
    handleError(ctx, error, 'Failed to delete proxy node')
  }
})

router.post('/nodes/:id/test', async (ctx: Context) => {
  try {
    const result = await proxyPoolManager.testNode(ctx.params.id)
    ctx.status = result.success ? 200 : 400
    ctx.body = result.success
      ? createSuccessResponse(result)
      : createErrorResponse('proxy_test_failed', result.error || 'Proxy test failed')
  } catch (error) {
    handleError(ctx, error, 'Failed to test proxy node')
  }
})

router.post('/nodes/:id/geo/resolve', async (ctx: Context) => {
  try {
    const force = Boolean((ctx.request.body as { force?: boolean } | undefined)?.force)
    const result = await proxyPoolManager.resolveNodeGeo(ctx.params.id, force)
    ctx.status = result.success ? 200 : 400
    ctx.body = result.success
      ? createSuccessResponse(result)
      : createErrorResponse('proxy_geo_resolve_failed', result.error || 'Failed to resolve proxy geo')
  } catch (error) {
    handleError(ctx, error, 'Failed to resolve proxy geo')
  }
})

router.post('/nodes/geo/resolve', async (ctx: Context) => {
  try {
    const force = Boolean((ctx.request.body as { force?: boolean } | undefined)?.force)
    ctx.body = createSuccessResponse(await proxyPoolManager.resolveAllGeo(force))
  } catch (error) {
    handleError(ctx, error, 'Failed to resolve proxy geo')
  }
})

router.post('/accounts/:id/proxy/assign', async (ctx: Context) => {
  try {
    ctx.body = createSuccessResponse(proxyPoolManager.assignAccount(ctx.params.id))
  } catch (error) {
    handleError(ctx, error, 'Failed to assign proxy')
  }
})

router.delete('/accounts/:id/proxy', async (ctx: Context) => {
  try {
    ctx.body = createSuccessResponse(proxyPoolManager.releaseAccount(ctx.params.id))
  } catch (error) {
    handleError(ctx, error, 'Failed to release proxy')
  }
})

export default router
