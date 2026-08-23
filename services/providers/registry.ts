import { Provider, ProviderConfig } from './types';
import { SiliconFlowProvider } from './siliconflow';
import { DashScopeProvider } from './dashscope';
import { ZhipuProvider } from './zhipu';
import { CustomProvider } from './custom';

/**
 * Provider 注册表 + 工厂
 * - 新加一个 provider：建一个 class，push 到 PROVIDERS，再写一个默认配置
 * - 顺序就是 UI 下拉顺序
 */

export const PROVIDERS: Provider[] = [
  new SiliconFlowProvider(),
  new DashScopeProvider(),
  new ZhipuProvider(),
  new CustomProvider(),
];

export function findProvider(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Provider 默认配置（用户首次打开时填充） */
export function defaultProviderConfig(provider: Provider): ProviderConfig {
  return {
    apiKey: '',
    baseUrl: provider.defaultBaseUrl,
    asrModel: provider.defaultAsrModel,
    llmModel: provider.defaultLlmModel,
  };
}

/** 把分散存的设置（apiKey、providerId、baseUrl、asrModel、llmModel）合并成 ProviderConfig */
export function buildProviderConfig(
  provider: Provider,
  parts: {
    apiKey: string;
    baseUrl?: string;
    asrModel?: string;
    llmModel?: string;
  },
): ProviderConfig {
  return {
    apiKey: parts.apiKey,
    baseUrl: parts.baseUrl?.trim() || provider.defaultBaseUrl,
    asrModel: parts.asrModel?.trim() || provider.defaultAsrModel,
    llmModel: parts.llmModel?.trim() || provider.defaultLlmModel,
  };
}
