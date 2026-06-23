import { storeManager } from '../store/store'
import type {
  Account,
  AccountProxyMode,
  Provider,
  ProxyGeoResolveBatchResult,
  ProxyGeoResolveResult,
  ProxyNode,
} from '../store/types'
import {
  isProxyNodeAssignable,
  isProxyNodeUsedByProvider,
  normalizeProxyMode,
  selectProxyNodeForAccount,
} from './proxyPoolRules'
import { resolveProxyGeoViaNode } from './proxyGeoResolver'

export interface ProxyAssignment {
  account: Account
  proxyNode?: ProxyNode
  error?: string
}

export interface ProxyFailureResult {
  account: Account
  proxyNode?: ProxyNode
  switched: boolean
  error?: string
}

export interface RequiredProxyAssignment {
  account: Account
  proxyNode: ProxyNode
  error?: never
}

export interface CreateProxyNodeInput {
  name: string
  host: string
  port: number
  username?: string
  password?: string
  province?: string
  city?: string
  regionCode?: string
  enabled?: boolean
}

function maskProxyNode(node: ProxyNode): ProxyNode {
  return {
    ...node,
    password: node.password ? '***' : undefined,
  }
}

export class ProxyPoolManager {
  getAll(includeSecrets: boolean = false): ProxyNode[] {
    return storeManager.getProxyNodes(includeSecrets)
  }

  getById(id: string, includeSecrets: boolean = false): ProxyNode | undefined {
    return storeManager.getProxyNodeById(id, includeSecrets)
  }

  create(input: CreateProxyNodeInput): ProxyNode {
    const name = input.name.trim()
    const host = input.host.trim()
    const port = Number(input.port)
    this.validateCredentials(input.username, input.password)

    if (!name) throw new Error('Proxy node name is required')
    if (!host) throw new Error('Proxy host is required')
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Proxy port must be between 1 and 65535')
    }

    const now = Date.now()
    const node: ProxyNode = {
      id: storeManager.generateId(),
      name,
      host,
      port,
      username: input.username?.trim() || undefined,
      password: input.password || undefined,
      province: input.province?.trim() || undefined,
      city: input.city?.trim() || undefined,
      regionCode: input.regionCode?.trim().toUpperCase() || undefined,
      enabled: input.enabled ?? true,
      status: input.enabled === false ? 'inactive' : 'active',
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    storeManager.addProxyNode(node)
    storeManager.addLog('info', `Created proxy node: ${node.name}`, {
      data: { proxyId: node.id, host: node.host, port: node.port },
    })
    return maskProxyNode(node)
  }

  update(id: string, updates: Partial<CreateProxyNodeInput & Pick<ProxyNode, 'status' | 'errorMessage'>>): ProxyNode | null {
    const existing = storeManager.getProxyNodeById(id, true)
    if (!existing) return null

    const nextUpdates: Partial<ProxyNode> = {}
    if (updates.name !== undefined) {
      const name = updates.name.trim()
      if (!name) throw new Error('Proxy node name is required')
      nextUpdates.name = name
    }
    if (updates.host !== undefined) {
      const host = updates.host.trim()
      if (!host) throw new Error('Proxy host is required')
      nextUpdates.host = host
    }
    if (updates.port !== undefined) {
      const port = Number(updates.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Proxy port must be between 1 and 65535')
      }
      nextUpdates.port = port
    }
    if (updates.username !== undefined) nextUpdates.username = updates.username.trim() || undefined
    if (updates.password !== undefined) nextUpdates.password = updates.password || undefined
    if (updates.province !== undefined) nextUpdates.province = updates.province.trim() || undefined
    if (updates.city !== undefined) nextUpdates.city = updates.city.trim() || undefined
    if (updates.regionCode !== undefined) nextUpdates.regionCode = updates.regionCode.trim().toUpperCase() || undefined
    if (updates.username !== undefined || updates.password !== undefined) {
      this.validateCredentials(
        updates.username !== undefined ? nextUpdates.username : existing.username,
        updates.password !== undefined ? nextUpdates.password : existing.password
      )
    }
    if (updates.enabled !== undefined) {
      nextUpdates.enabled = updates.enabled
      if (!updates.enabled) {
        nextUpdates.status = 'inactive'
        nextUpdates.cooldownUntil = undefined
        this.releaseBindingsForProxy(id)
      } else if (existing.status === 'inactive') {
        nextUpdates.status = 'active'
        nextUpdates.errorMessage = undefined
      }
    }
    if (updates.status !== undefined) nextUpdates.status = updates.status
    if (updates.errorMessage !== undefined) nextUpdates.errorMessage = updates.errorMessage

    const updated = storeManager.updateProxyNode(id, nextUpdates)
    return updated ? maskProxyNode(updated) : null
  }

  delete(id: string): boolean {
    const node = storeManager.getProxyNodeById(id)
    const deleted = storeManager.deleteProxyNode(id)
    if (deleted && node) {
      this.releaseBindingsForProxy(id)
      storeManager.addLog('info', `Deleted proxy node: ${node.name}`, {
        data: { proxyId: id },
      })
    }
    return deleted
  }

  async testNode(id: string): Promise<{ success: boolean; latency?: number; error?: string; node?: ProxyNode }> {
    const node = storeManager.getProxyNodeById(id, true)
    if (!node) {
      return { success: false, error: 'Proxy node not found' }
    }

    const startTime = Date.now()
    try {
      const geo = await resolveProxyGeoViaNode(node, storeManager.getConfig().proxyPoolConfig.testTimeoutMs)
      const updated = storeManager.updateProxyNode(id, {
        status: node.enabled ? 'active' : 'inactive',
        failureCount: 0,
        errorMessage: undefined,
        cooldownUntil: undefined,
        lastCheckedAt: Date.now(),
        province: geo.province || node.province,
        city: geo.city || node.city,
        regionCode: geo.regionCode || node.regionCode,
      })
      return {
        success: true,
        latency: Date.now() - startTime,
        node: updated ? maskProxyNode(updated) : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proxy test failed'
      const updated = storeManager.updateProxyNode(id, {
        status: 'error',
        failureCount: (node.failureCount || 0) + 1,
        errorMessage: message,
        lastFailedAt: Date.now(),
        lastCheckedAt: Date.now(),
      })
      return {
        success: false,
        error: message,
        latency: Date.now() - startTime,
        node: updated ? maskProxyNode(updated) : undefined,
      }
    }
  }

  async resolveNodeGeo(id: string, force: boolean = false): Promise<ProxyGeoResolveResult> {
    const node = storeManager.getProxyNodeById(id, true)
    if (!node) {
      return { id, success: false, error: 'Proxy node not found' }
    }

    if (!force && node.province && node.city && node.regionCode) {
      return {
        id,
        success: true,
        geo: {
          province: node.province,
          city: node.city,
          regionCode: node.regionCode,
        },
        node: maskProxyNode(node),
      }
    }

    try {
      const geo = await resolveProxyGeoViaNode(node)
      const updated = storeManager.updateProxyNode(id, {
        province: geo.province,
        city: geo.city,
        regionCode: geo.regionCode,
      })

      return {
        id,
        success: true,
        geo,
        node: updated ? maskProxyNode(updated) : undefined,
      }
    } catch (error) {
      return {
        id,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resolve proxy location',
      }
    }
  }

  async resolveAllGeo(force: boolean = false): Promise<ProxyGeoResolveBatchResult> {
    const nodes = storeManager.getProxyNodes(false)
    const results: ProxyGeoResolveResult[] = []
    let skipped = 0

    for (const node of nodes) {
      if (!force && node.province && node.city && node.regionCode) {
        skipped++
        results.push({
          id: node.id,
          success: true,
          geo: {
            province: node.province,
            city: node.city,
            regionCode: node.regionCode,
          },
          node,
        })
        continue
      }

      results.push(await this.resolveNodeGeo(node.id, force))
    }

    const resolved = results.filter(result => result.success).length - skipped
    const failed = results.filter(result => !result.success).length
    return {
      total: nodes.length,
      resolved,
      skipped,
      failed,
      results,
    }
  }

  async ensureAccountProxy(account: Account, provider: Provider): Promise<ProxyAssignment> {
    if (normalizeProxyMode(account.proxyMode) !== 'auto') {
      return { account: { ...account, proxyMode: 'none', proxyBinding: undefined } }
    }

    const currentProxyId = account.proxyBinding?.proxyId
    if (currentProxyId) {
      const currentNode = storeManager.getProxyNodeById(currentProxyId, true)
      if (currentNode && this.canUseNode(currentNode) && !this.isNodeUsedByProvider(currentNode.id, provider.id, account.id)) {
        return { account, proxyNode: currentNode }
      }
    }

    const proxyNode = this.selectAvailableNode(provider.id, account.id)
    if (!proxyNode) {
      storeManager.addLog('warn', `No available proxy for account ${account.name}; leaving proxy unassigned`, {
        accountId: account.id,
        providerId: provider.id,
      })
      return { account }
    }

    const updated = this.bindAccount(account, proxyNode, false)
    return { account: updated, proxyNode }
  }

  async ensureRequiredAccountProxyForCity(account: Account, provider: Provider, city?: string): Promise<ProxyAssignment | RequiredProxyAssignment> {
    const requestedCity = city?.trim()
    const accountForProxy: Account = normalizeProxyMode(account.proxyMode) === 'auto'
      ? account
      : {
          ...account,
          proxyMode: 'auto',
        }

    const currentProxyId = accountForProxy.proxyBinding?.proxyId
    if (currentProxyId) {
      const currentNode = storeManager.getProxyNodeById(currentProxyId, true)
      if (currentNode && this.canUseNode(currentNode) && !this.isNodeUsedByProvider(currentNode.id, provider.id, accountForProxy.id)) {
        const updated = normalizeProxyMode(account.proxyMode) === 'auto'
          ? accountForProxy
          : this.bindAccount(accountForProxy, currentNode, false)
        return { account: updated, proxyNode: currentNode }
      }
    }

    const cityProxyNode = requestedCity
      ? this.selectAvailableNodeByCity(provider.id, accountForProxy.id, requestedCity)
      : undefined
    const proxyNode = cityProxyNode || this.selectAvailableNode(provider.id, accountForProxy.id)
    if (!proxyNode) {
      storeManager.addLog('warn', `No required proxy available for account ${account.name}; rejecting model request`, {
        accountId: account.id,
        providerId: provider.id,
        data: { city: requestedCity || undefined },
      })
      return {
        account: accountForProxy,
        error: 'no_available_proxy',
      }
    }

    const updated = this.bindAccount(accountForProxy, proxyNode, false)
    return { account: updated, proxyNode }
  }

  async ensureAccountProxyForCity(account: Account, provider: Provider, city?: string): Promise<ProxyAssignment> {
    const requestedCity = city?.trim()
    if (!requestedCity) {
      return this.ensureAccountProxy(account, provider)
    }

    if (normalizeProxyMode(account.proxyMode) !== 'auto') {
      return { account: { ...account, proxyMode: 'none', proxyBinding: undefined } }
    }

    const currentProxyId = account.proxyBinding?.proxyId
    if (currentProxyId) {
      const currentNode = storeManager.getProxyNodeById(currentProxyId, true)
      if (currentNode && this.canUseNode(currentNode) && !this.isNodeUsedByProvider(currentNode.id, provider.id, account.id)) {
        return { account, proxyNode: currentNode }
      }
    }

    const proxyNode = this.selectAvailableNodeByCity(provider.id, account.id, requestedCity)
    if (!proxyNode) {
      console.log(`[ProxyPool] No available proxy node for city "${requestedCity}", falling back to default pool`)
      return this.ensureAccountProxy(account, provider)
    }

    const updated = this.bindAccount(account, proxyNode, false)
    return { account: updated, proxyNode }
  }

  assignAccount(accountId: string): ProxyAssignment {
    const account = storeManager.getAccountById(accountId, true)
    if (!account) throw new Error('Account not found')

    const provider = storeManager.getProviderById(account.providerId)
    if (!provider) throw new Error('Provider not found')

    const proxyNode = this.selectAvailableNode(provider.id, account.id)
    if (!proxyNode) throw new Error('No available proxy node for this provider')

    const updated = this.bindAccount(
      {
        ...account,
        proxyMode: 'auto',
      },
      proxyNode,
      false,
    )

    return { account: updated, proxyNode: maskProxyNode(proxyNode) }
  }

  releaseAccount(accountId: string): Account {
    const account = storeManager.getAccountById(accountId, true)
    if (!account) throw new Error('Account not found')

    const updated = storeManager.updateAccount(accountId, {
      proxyMode: 'none',
      proxyBinding: undefined,
    })
    if (!updated) throw new Error('Failed to release proxy binding')
    return updated
  }

  handleProxyFailure(account: Account, provider: Provider, proxyNode: ProxyNode | undefined, error: unknown): ProxyFailureResult {
    const message = error instanceof Error ? error.message : String(error)

    if (proxyNode) {
      this.markNodeFailed(proxyNode.id, message)
    }

    if (normalizeProxyMode(account.proxyMode) !== 'auto') {
      return { account, proxyNode, switched: false, error: message }
    }

    const nextProxyNode = this.selectAvailableNode(provider.id, account.id, proxyNode?.id)
    if (!nextProxyNode) {
      storeManager.addLog('warn', `Proxy pool exhausted for account ${account.name}; no proxy switch available`, {
        accountId: account.id,
        providerId: provider.id,
        proxyId: proxyNode?.id,
        data: { error: message },
      })
      return {
        account,
        proxyNode,
        switched: false,
        error: message,
      }
    }

    const updated = this.bindAccount(account, nextProxyNode, true)
    return { account: updated, proxyNode: nextProxyNode, switched: true, error: message }
  }

  markNodeSuccess(proxyId: string): void {
    const node = storeManager.getProxyNodeById(proxyId, true)
    if (!node) return
    storeManager.updateProxyNode(proxyId, {
      status: node.enabled ? 'active' : 'inactive',
      failureCount: 0,
      errorMessage: undefined,
      cooldownUntil: undefined,
      lastCheckedAt: Date.now(),
    })
  }

  markNodeFailed(proxyId: string, errorMessage: string): void {
    const node = storeManager.getProxyNodeById(proxyId, true)
    if (!node) return

    const config = storeManager.getConfig().proxyPoolConfig
    const failureCount = (node.failureCount || 0) + 1
    const now = Date.now()
    const inCooldown = failureCount >= config.failThreshold
    storeManager.updateProxyNode(proxyId, {
      status: inCooldown ? 'cooldown' : 'error',
      failureCount,
      errorMessage,
      lastFailedAt: now,
      cooldownUntil: inCooldown ? now + config.cooldownMs : undefined,
    })
  }

  private bindAccount(account: Account, proxyNode: ProxyNode, isSwitch: boolean): Account {
    const now = Date.now()
    const updated = storeManager.updateAccount(account.id, {
      proxyMode: 'auto',
      proxyBinding: {
        proxyId: proxyNode.id,
        assignedAt: account.proxyBinding?.assignedAt || now,
        lastSwitchAt: isSwitch ? now : account.proxyBinding?.lastSwitchAt,
        switchCount: (account.proxyBinding?.switchCount || 0) + (isSwitch ? 1 : 0),
      },
    })
    if (!updated) throw new Error('Failed to bind proxy node')
    return updated
  }

  private canUseNode(node: ProxyNode): boolean {
    return isProxyNodeAssignable(node)
  }

  private selectAvailableNode(providerId: string, accountId: string, excludedProxyId?: string): ProxyNode | undefined {
    return selectProxyNodeForAccount(
      storeManager.getProxyNodes(true),
      storeManager.getAccounts(false),
      providerId,
      accountId,
      excludedProxyId
    )
  }

  private selectAvailableNodeByCity(providerId: string, accountId: string, city: string): ProxyNode | undefined {
    const normalizedCity = normalizeCityName(city)
    if (!normalizedCity) return undefined

    return storeManager.getProxyNodes(true)
      .filter(node => isProxyNodeAssignable(node))
      .filter(node => normalizeCityName(node.city) === normalizedCity)
      .filter(node => !this.isNodeUsedByProvider(node.id, providerId, accountId))
      .sort((a, b) => {
        const failureDiff = (a.failureCount || 0) - (b.failureCount || 0)
        if (failureDiff !== 0) return failureDiff
        return (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0)
      })[0]
  }

  private isNodeUsedByProvider(proxyId: string, providerId: string, exceptAccountId?: string): boolean {
    return isProxyNodeUsedByProvider(storeManager.getAccounts(false), proxyId, providerId, exceptAccountId)
  }

  private releaseBindingsForProxy(proxyId: string): void {
    const accounts = storeManager.getAccounts(false)
    for (const account of accounts) {
      if (account.proxyMode === 'auto' && account.proxyBinding?.proxyId === proxyId) {
        storeManager.updateAccount(account.id, { proxyBinding: undefined })
      }
    }
  }

  private validateCredentials(username?: string, password?: string): void {
    const usernameLength = Buffer.byteLength(username || '')
    const passwordLength = Buffer.byteLength(password || '')
    if (usernameLength > 255 || passwordLength > 255) {
      throw new Error('SOCKS5 username and password must be at most 255 bytes')
    }
  }
}

function normalizeCityName(city?: string): string {
  return (city || '').trim().replace(/市$/, '').toLowerCase()
}

export const proxyPoolManager = new ProxyPoolManager()
export default proxyPoolManager
