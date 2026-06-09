import { EventEmitter } from 'node:events'
import net from 'node:net'
import crypto from 'node:crypto'

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
}

class WebSocketTransport extends EventEmitter {
  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0)
  private connected = false

  async connect(wsUrl: string): Promise<void> {
    const url = new URL(wsUrl)
    if (url.protocol !== 'ws:') {
      throw new Error(`Unsupported DevTools protocol URL: ${url.protocol}`)
    }

    const port = Number(url.port || 80)
    const key = crypto.randomBytes(16).toString('base64')

    this.socket = net.createConnection({ host: url.hostname, port })
    this.socket.on('data', (chunk) => this.handleData(chunk))
    this.socket.on('close', () => this.emit('close'))
    this.socket.on('error', (error) => this.emit('error', error))

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!
      let timeout: NodeJS.Timeout | null = null

      const cleanup = () => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', fail)
        socket.removeListener('close', onClose)
        this.removeListener('open', onOpen)
        this.removeListener('error', fail)
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
      }

      const fail = (error: Error) => {
        cleanup()
        reject(error)
      }

      const onClose = () => {
        fail(new Error('DevTools WebSocket closed before handshake completed'))
      }

      const onOpen = () => {
        cleanup()
        resolve()
      }

      const onConnect = () => {
        socket.write(
          [
            `GET ${url.pathname}${url.search} HTTP/1.1`,
            `Host: ${url.host}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        )
      }

      timeout = setTimeout(() => {
        fail(new Error('DevTools WebSocket handshake timed out'))
      }, 10000)

      socket.once('connect', onConnect)
      socket.once('error', fail)
      socket.once('close', onClose)
      this.once('open', onOpen)
      this.once('error', fail)
    })
  }

  sendText(payload: string): void {
    if (!this.socket || !this.connected) {
      throw new Error('DevTools WebSocket is not connected')
    }

    this.socket.write(createClientFrame(Buffer.from(payload, 'utf-8'), 0x1))
  }

  close(): void {
    if (!this.socket) return

    try {
      if (this.connected) {
        this.socket.write(createClientFrame(Buffer.alloc(0), 0x8))
      }
      this.socket.end()
    } catch {
      this.socket.destroy()
    } finally {
      this.socket = null
      this.connected = false
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    if (!this.connected) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const header = this.buffer.slice(0, headerEnd).toString('utf-8')
      if (!header.startsWith('HTTP/1.1 101') && !header.startsWith('HTTP/1.0 101')) {
        this.emit('error', new Error(`DevTools WebSocket handshake failed: ${header.split('\r\n')[0]}`))
        this.close()
        return
      }

      this.connected = true
      this.buffer = this.buffer.slice(headerEnd + 4)
      this.emit('open')
    }

    this.parseFrames()
  }

  private parseFrames(): void {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0]
      const secondByte = this.buffer[1]
      const opcode = firstByte & 0x0f
      const masked = (secondByte & 0x80) !== 0
      let payloadLength = secondByte & 0x7f
      let offset = 2

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return
        payloadLength = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return
        const longLength = this.buffer.readBigUInt64BE(offset)
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emit('error', new Error('DevTools WebSocket frame is too large'))
          this.close()
          return
        }
        payloadLength = Number(longLength)
        offset += 8
      }

      const maskOffset = masked ? 4 : 0
      if (this.buffer.length < offset + maskOffset + payloadLength) return

      let payload = this.buffer.slice(offset + maskOffset, offset + maskOffset + payloadLength)
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4)
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))
      }

      this.buffer = this.buffer.slice(offset + maskOffset + payloadLength)

      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf-8'))
      } else if (opcode === 0x8) {
        this.close()
        return
      } else if (opcode === 0x9 && this.socket) {
        this.socket.write(createClientFrame(payload, 0xA))
      }
    }
  }
}

export class ChromeCdpClient extends EventEmitter {
  private readonly transport = new WebSocketTransport()
  private nextId = 1
  private pending = new Map<number, PendingCommand>()

  static async connect(webSocketDebuggerUrl: string): Promise<ChromeCdpClient> {
    const client = new ChromeCdpClient()
    await client.connect(webSocketDebuggerUrl)
    return client
  }

  private async connect(webSocketDebuggerUrl: string): Promise<void> {
    this.transport.on('message', (message) => this.handleMessage(message))
    this.transport.on('close', () => this.rejectPending(new Error('DevTools WebSocket closed')))
    this.transport.on('error', (error) => this.rejectPending(error instanceof Error ? error : new Error(String(error))))
    await this.transport.connect(webSocketDebuggerUrl)
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params: params || {} })

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      })

      try {
        this.transport.sendText(payload)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    this.transport.close()
  }

  private handleMessage(message: string): void {
    let parsed: any
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id)
      if (!pending) return

      this.pending.delete(parsed.id)
      if (parsed.error) {
        pending.reject(new Error(`${pending.method} failed: ${parsed.error.message || JSON.stringify(parsed.error)}`))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    if (parsed.method) {
      this.emit(parsed.method, parsed.params)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of Array.from(this.pending.values())) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function createClientFrame(payload: Buffer, opcode: number): Buffer {
  const mask = crypto.randomBytes(4)
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10
  const frame = Buffer.alloc(headerLength + 4 + payload.length)

  frame[0] = 0x80 | opcode

  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(payload.length, 2)
  } else {
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(payload.length), 2)
  }

  const maskOffset = headerLength
  mask.copy(frame, maskOffset)

  for (let index = 0; index < payload.length; index += 1) {
    frame[maskOffset + 4 + index] = payload[index] ^ mask[index % 4]
  }

  return frame
}
