import type { BuiltinProviderConfig } from '../../store/types'

export const doubaoConfig: BuiltinProviderConfig = {
  id: 'doubao',
  name: 'Doubao',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.doubao.com',
  chatPath: '/chat/completion',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://www.doubao.com',
    'Referer': 'https://www.doubao.com/chat/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  },
  enabled: true,
  description: 'Doubao web assistant via browser-backed signed requests',
  supportedModels: [
    'doubao',
    'doubao-thinking',
  ],
  modelMappings: {
    doubao: '7338286299411103781',
    'doubao-thinking': '7338286299411103781',
  },
  credentialFields: [
    {
      name: 'sessionid',
      label: 'sessionid',
      type: 'password',
      required: true,
      placeholder: 'Enter Doubao sessionid cookie value',
      helpText: 'Found in browser DevTools -> Application -> Cookies -> www.doubao.com -> sessionid',
    },
    {
      name: 'cookie',
      label: 'Full Cookie',
      type: 'textarea',
      required: false,
      placeholder: 'Optional full Cookie header from doubao.com',
      helpText: 'Optional. Paste full Cookie header if sessionid alone is not enough for your account.',
    },
    {
      name: 'fp',
      label: 'Fingerprint',
      type: 'password',
      required: false,
      placeholder: 'Optional verify_* fingerprint',
      helpText: 'Optional. Use the fp value captured from Doubao traffic if automatic extraction fails.',
    },
  ],
}

export default doubaoConfig
