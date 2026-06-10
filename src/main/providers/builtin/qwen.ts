import type { BuiltinProviderConfig } from '../../store/types'

export const qwenConfig: BuiltinProviderConfig = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'tongyi_sso_ticket',
  apiEndpoint: 'https://chat2.qianwen.com',
  chatPath: '/api/v2/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream, text/plain, */*',
    'Origin': 'https://www.qianwen.com',
    'Referer': 'https://www.qianwen.com/',
  },
  enabled: true,
  description: 'Qwen AI assistant by Alibaba Cloud (www.qianwen.com)',
  supportedModels: [
    'Qwen3.7-千问',
    'Qwen3.7-Max',
    'Qwen3.5-Flash',
    'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder',
  ],
  modelMappings: {
    'Qwen3.7-千问': 'Qwen',
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.5-Flash': 'Qwen3.5-Flash',
    'Qwen3-Max': 'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder': 'Qwen3-Coder',
  },
  credentialFields: [
    {
      name: 'ticket',
      label: 'SSO Ticket',
      type: 'password',
      required: true,
      placeholder: 'Enter tongyi_sso_ticket',
      helpText: 'SSO ticket obtained from www.qianwen.com, found in browser DevTools Application -> Cookies as tongyi_sso_ticket',
    },
    {
      name: 'cookie',
      label: 'Full Cookie',
      type: 'textarea',
      required: false,
      placeholder: 'Optional full Cookie header from www.qianwen.com',
      helpText: 'Optional. Use this when tongyi_sso_ticket alone is rejected by Qianwen web API.',
    },
    {
      name: 'csrfToken',
      label: 'CSRF Token',
      type: 'password',
      required: false,
      placeholder: 'Optional x-csrf-token / X-XSRF-TOKEN',
      helpText: 'Optional token from Qianwen web requests.',
    },
    {
      name: 'umidToken',
      label: 'UMID Token',
      type: 'password',
      required: false,
      placeholder: 'Optional bx-umidtoken',
      helpText: 'Optional bx-umidtoken from Qianwen web requests.',
    },
    {
      name: 'deviceId',
      label: 'Device ID',
      type: 'text',
      required: false,
      placeholder: 'Optional x-device-id / ut value',
      helpText: 'Optional. Leave empty to use the default Chat2API device id.',
    },
  ],
}

export default qwenConfig
