import deepseekConfig from './deepseek.ts'
import doubaoConfig from './doubao.ts'
import yuanbaoConfig from './yuanbao.ts'
import kimiConfig from './kimi.ts'
import qwenConfig from './qwen.ts'
// import glmConfig from './glm.ts'
// import minimaxConfig from './minimax.ts'
// import mimoConfig from './mimo.ts'
// import perplexityConfig from './perplexity.ts'
// import qwenAiConfig from './qwen-ai.ts'
// import zaiConfig from './zai.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
  doubaoConfig,
  yuanbaoConfig,
  kimiConfig,
  qwenConfig,
  // glmConfig,
  // minimaxConfig,
  // mimoConfig,
  // perplexityConfig,
  // qwenAiConfig,
  // zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  deepseek: deepseekConfig,
  doubao: doubaoConfig,
  yuanbao: yuanbaoConfig,
  kimi: kimiConfig,
  qwen: qwenConfig,
  // glm: glmConfig,
  // minimax: minimaxConfig,
  // mimo: mimoConfig,
  // perplexity: perplexityConfig,
  // 'qwen-ai': qwenAiConfig,
  // zai: zaiConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export {
  deepseekConfig,
  doubaoConfig,
  yuanbaoConfig,
  kimiConfig,
  qwenConfig,
  // glmConfig,
  // minimaxConfig,
  // mimoConfig,
  // perplexityConfig,
  // qwenAiConfig,
  // zaiConfig,
}

export default builtinProviders
