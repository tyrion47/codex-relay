module.exports = {
  deepseek: { wire: "chat", reasoning: "deepseekThinking", effort: ["high", "max"], maxTokens: 64000, vision: false, endpoint: "/chat/completions" },
  kimi: { wire: "chat", reasoning: "native", fixedTemperature: 1, maxTokens: 64000, vision: false },
  sakana: { wire: "chat", reasoning: "effort", effort: ["high", "xhigh", "max"], maxTokens: 64000, vision: false },
  gemini: { wire: "chat", reasoning: "maxtok", reasoningBudget: 1024, maxTokens: 64000, vision: true, extraHeaders: { "HTTP-Referer": "https://localhost/codex-relay", "X-Title": "codex-relay" } },
  "openrouter-free": { wire: "chat", reasoning: "strip", maxTokens: 8192, vision: false, extraHeaders: { "HTTP-Referer": "https://localhost/codex-relay", "X-Title": "codex-relay" } },
  "openrouter-paid": { wire: "chat", reasoning: "maxtok", reasoningBudget: 8192, maxTokens: 64000, vision: false, extraHeaders: { "HTTP-Referer": "https://localhost/codex-relay", "X-Title": "codex-relay" }, extraBody: { provider: { order: ["deepseek"], allow_fallbacks: true } } },
  nvidia: { wire: "chat", reasoning: "chatTemplate", thinkingKey: "enable_thinking", reasoningBudget: 16384, maxTokens: 16384, vision: false },
  "nvidia-reasoning": { wire: "chat", reasoning: "chatTemplate", thinkingKey: "enable_thinking", reasoningBudget: 16384, toolMaxTokensFloor: 8192, maxTokens: 65536, vision: false },
  "nvidia-plain": { wire: "chat", reasoning: "strip", toolMaxTokensFloor: 4096, maxTokens: 65536, vision: false },
  "nvidia-minimax": { wire: "chat", reasoning: "strip", maxTokens: 8192, vision: true },
  "nvidia-deepseek-pro": { wire: "chat", reasoning: "chatTemplate", thinkingKey: "thinking", maxTokens: 16384, vision: false },
  "nvidia-deepseek-flash": { wire: "chat", reasoning: "chatTemplate", thinkingKey: "thinking", reasoningEffort: "high", maxTokens: 16384, vision: false },
  "nvidia-gemma": { wire: "chat", reasoning: "chatTemplate", thinkingKey: "enable_thinking", maxTokens: 16384, vision: false },
  zai: { wire: "chat", reasoning: "thinkingEffort", effort: ["high", "max"], maxTokens: 64000, vision: false },
  "zai-vision": { wire: "chat", reasoning: "thinkingEffort", effort: ["high", "max"], maxTokens: 64000, vision: true },
  "litellm-cf": { wire: "chat", reasoning: "strip", maxTokens: 8192, vision: false },
  openai: { wire: "responses", reasoning: "responses", maxTokens: 128000, vision: true }
};
