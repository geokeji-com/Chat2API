import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type {
  GatewayHeartbeat,
  GatewayRegistrationAck,
  GatewayTaskFailure,
  GatewayTaskLeaseBatch,
  GatewayTaskLeaseRequest,
  GatewayTaskResult,
  WorkerRegistration,
} from '../../shared/gatewayWorker.ts'

export interface GatewayClient {
  registerWorker(registration: WorkerRegistration): Promise<GatewayRegistrationAck>
  heartbeat(heartbeat: GatewayHeartbeat): Promise<void>
  leaseTasks(request: GatewayTaskLeaseRequest): Promise<GatewayTaskLeaseBatch>
  submitResult(result: GatewayTaskResult): Promise<void>
  submitFailure(failure: GatewayTaskFailure): Promise<void>
}

export interface HttpGatewayClientOptions {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

export class HttpGatewayClient implements GatewayClient {
  private readonly http: AxiosInstance

  constructor(options: HttpGatewayClientOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl.replace(/\/+$/, ''),
      timeout: options.timeoutMs || 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      validateStatus: status => status >= 200 && status < 300,
    })
  }

  async registerWorker(registration: WorkerRegistration): Promise<GatewayRegistrationAck> {
    const response = await this.http.post<GatewayRegistrationAck>('/workers/register', registration)
    return response.data
  }

  async heartbeat(heartbeat: GatewayHeartbeat): Promise<void> {
    await this.http.post('/workers/heartbeat', heartbeat)
  }

  async leaseTasks(request: GatewayTaskLeaseRequest): Promise<GatewayTaskLeaseBatch> {
    const response = await this.http.post<GatewayTaskLeaseBatch>('/tasks/lease', request)
    return response.data
  }

  async submitResult(result: GatewayTaskResult): Promise<void> {
    await this.http.post(`/tasks/${encodeURIComponent(result.task_id)}/result`, result)
  }

  async submitFailure(failure: GatewayTaskFailure): Promise<void> {
    await this.http.post(`/tasks/${encodeURIComponent(failure.task_id)}/fail`, failure)
  }
}
