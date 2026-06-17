import http from 'http'
import https from 'https'
import net from 'net'
import type { Duplex } from 'stream'
import { SocksClient } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxyNode } from '../store/types.ts'
import { buildSocksProxyUrl } from './proxyTransport.ts'

const LOCAL_RELAY_HOST = '127.0.0.1'
const RELAY_CONNECT_TIMEOUT_MS = 30000
const RELAY_IDLE_TIMEOUT_MS = 2 * 60 * 1000

export interface LocalRelayProxyHandle {
  proxyRules: string
  port: number
  release: () => void
}

interface RelayEntry {
  nodeId: string
  fingerprint: string
  server: http.Server
  sockets: Set<net.Socket>
  port: number
  proxyRules: string
  refCount: number
  idleTimer?: NodeJS.Timeout
}

export class LocalRelayProxyManager {
  private relays = new Map<string, RelayEntry>()

  async acquire(node: ProxyNode): Promise<LocalRelayProxyHandle> {
    const key = node.id
    const fingerprint = this.createFingerprint(node)
    const existing = this.relays.get(key)

    if (existing && existing.fingerprint !== fingerprint) {
      this.stop(existing)
      this.relays.delete(key)
    }

    let entry = this.relays.get(key)
    if (!entry) {
      entry = await this.start(node, fingerprint)
      this.relays.set(key, entry)
      console.log(`[LocalRelayProxy] Started relay for proxy ${node.name} on ${LOCAL_RELAY_HOST}:${entry.port}`)
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.refCount += 1

    return {
      proxyRules: entry.proxyRules,
      port: entry.port,
      release: () => this.release(key, fingerprint),
    }
  }

  private release(key: string, fingerprint: string): void {
    const entry = this.relays.get(key)
    if (!entry || entry.fingerprint !== fingerprint) return

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount > 0 || entry.idleTimer) return

    entry.idleTimer = setTimeout(() => {
      const current = this.relays.get(key)
      if (!current || current.refCount > 0 || current.fingerprint !== fingerprint) return

      this.stop(current)
      this.relays.delete(key)
    }, RELAY_IDLE_TIMEOUT_MS)
    entry.idleTimer.unref?.()
  }

  private async start(node: ProxyNode, fingerprint: string): Promise<RelayEntry> {
    const sockets = new Set<net.Socket>()
    const server = http.createServer((req, res) => {
      this.handleHttpRequest(node, req, res).catch(error => {
        this.sendHttpProxyError(res, error)
      })
    })

    server.on('connect', (req, clientSocket, head) => {
      this.handleConnect(node, req, clientSocket, head).catch(error => {
        const message = error instanceof Error ? error.message : 'Local relay CONNECT failed'
        console.warn(`[LocalRelayProxy] CONNECT failed for proxy ${node.name}: ${message}`)
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
          clientSocket.destroy()
        }
      })
    })

    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      }
    })

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Local relay did not bind to a TCP port'))
          return
        }
        resolve(address.port)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, LOCAL_RELAY_HOST)
    })

    return {
      nodeId: node.id,
      fingerprint,
      server,
      sockets,
      port,
      proxyRules: `${LOCAL_RELAY_HOST}:${port}`,
      refCount: 0,
    }
  }

  private stop(entry: RelayEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }

    entry.server.close(error => {
      if (error) {
        console.warn(`[LocalRelayProxy] Failed to close relay for proxy ${entry.nodeId}:`, error)
      }
    })
    entry.sockets.forEach(socket => socket.destroy())
  }

  private async handleConnect(
    node: ProxyNode,
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer
  ): Promise<void> {
    const { host, port } = this.parseConnectTarget(req.url)
    const result = await SocksClient.createConnection({
      proxy: {
        host: node.host,
        port: node.port,
        type: 5,
        userId: node.username,
        password: node.password,
      },
      command: 'connect',
      destination: { host, port },
      timeout: RELAY_CONNECT_TIMEOUT_MS,
    })

    const upstreamSocket = result.socket
    upstreamSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstreamSocket.destroy())

    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Chat2API\r\n\r\n')
    if (head.length > 0) {
      upstreamSocket.write(head)
    }

    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  }

  private async handleHttpRequest(
    node: ProxyNode,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const targetUrl = this.resolveRequestUrl(req)
    const transport = targetUrl.protocol === 'https:' ? https : http
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    const upstreamRequest = transport.request(targetUrl, {
      method: req.method,
      headers,
      agent: new SocksProxyAgent(buildSocksProxyUrl(node)),
      timeout: RELAY_CONNECT_TIMEOUT_MS,
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })

    upstreamRequest.on('timeout', () => {
      upstreamRequest.destroy(new Error('Local relay upstream request timed out'))
    })
    upstreamRequest.on('error', error => {
      this.sendHttpProxyError(res, error)
    })

    req.pipe(upstreamRequest)
  }

  private parseConnectTarget(rawUrl?: string): { host: string; port: number } {
    if (!rawUrl) {
      throw new Error('CONNECT target is empty')
    }

    const target = new URL(`http://${rawUrl}`)
    const port = Number(target.port || 443)
    if (!target.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid CONNECT target: ${rawUrl}`)
    }

    return { host: target.hostname, port }
  }

  private resolveRequestUrl(req: http.IncomingMessage): URL {
    const rawUrl = req.url || ''
    if (/^https?:\/\//i.test(rawUrl)) {
      return new URL(rawUrl)
    }

    const host = req.headers.host
    if (!host) {
      throw new Error('HTTP proxy request is missing Host header')
    }

    return new URL(rawUrl || '/', `http://${host}`)
  }

  private sendHttpProxyError(res: http.ServerResponse, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Local relay HTTP request failed'
    console.warn(`[LocalRelayProxy] HTTP request failed: ${message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end('Proxy relay request failed')
  }

  private createFingerprint(node: ProxyNode): string {
    return [
      node.host,
      node.port,
      node.username || '',
      node.password || '',
      node.updatedAt || '',
    ].join('\n')
  }
}

export const localRelayProxyManager = new LocalRelayProxyManager()
