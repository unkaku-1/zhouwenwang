/**
 * LLM Provider registry (frontend)
 *
 * Mirrors backend/providers/registry.js. Each provider entry exposes enough
 * info for the UI to render a model picker and for the service layer to
 * route a request to the right backend endpoint. The frontend always
 * prefers the backend (so API keys never leave the server) when a serverUrl
 * is configured, and falls back to a direct browser-side call otherwise.
 */

export type LLMProviderId = 'gemini' | 'minimax';

export interface LLMProviderConfig {
  id: LLMProviderId;
  displayName: string;
  /** env var name on the backend that holds the API key for this provider */
  envKey: string;
  /** placeholder shown in the API-key input */
  keyPlaceholder: string;
  /** default model used when the user hasn't picked one */
  defaultModel: string;
  /** list of model ids the user can pick from in the UI */
  models: { id: string; label: string }[];
  /** base URL the frontend hits when there's no backend proxy */
  directBaseUrl: string;
  /** how to put the API key into the upstream request (Authorization header value) */
  directAuthHeader: (apiKey: string) => Record<string, string>;
  /** Gemini-style contents → provider-native body, for direct browser-side calls */
  buildDirectRequest: (args: {
    contents: any;
    generationConfig?: any;
    model: string;
  }) => any;
  /** Pull text out of a non-streaming response */
  extractDirectText: (data: any) => string;
  /** Lightweight format check used by the Settings UI for inline validation. */
  isValidApiKeyFormat: (apiKey: string) => boolean;
  /** Whether the provider supports image inputs (vision). MiniMax: not via this surface. */
  supportsVision: boolean;
}

// ---------------------------------------------------------------------------
// Gemini (default; kept for back-compat with existing flows)
// ---------------------------------------------------------------------------

const geminiProvider: LLMProviderConfig = {
  id: 'gemini',
  displayName: 'Google Gemini',
  envKey: 'GEMINI_API_KEY',
  keyPlaceholder: 'AIzaSyC...',
  defaultModel: 'gemini-2.5-pro',
  models: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (推荐)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (快速)' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (轻量)' },
  ],
  directBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  directAuthHeader: (apiKey) => ({ 'x-goog-api-key': apiKey }),
  buildDirectRequest: ({ contents, generationConfig, model }) => ({
    contents,
    generationConfig: { temperature: 0.7, topK: 32, topP: 1, maxOutputTokens: 4096, ...(generationConfig || {}) },
    // model is consumed by the URL builder, not the body
    _model: model,
  }),
  extractDirectText: (data) => {
    const cand = data?.candidates?.[0];
    const part = cand?.content?.parts?.[0];
    return part?.text || '';
  },
  isValidApiKeyFormat: (apiKey) => apiKey.trim().length >= 20 && apiKey.trim().startsWith('AIza'),
  supportsVision: true,
};

// ---------------------------------------------------------------------------
// MiniMax (China endpoint by default)
// ---------------------------------------------------------------------------

const minimaxProvider: LLMProviderConfig = {
  id: 'minimax',
  displayName: 'MiniMax (MiniMax)',
  envKey: 'MINIMAX_API_KEY',
  keyPlaceholder: 'eyJ... MiniMax API Key',
  defaultModel: 'MiniMax-M3',
  models: [
    { id: 'MiniMax-M3', label: 'MiniMax-M3 (推荐, 最新)' },
    { id: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
    { id: 'MiniMax-M2.5', label: 'MiniMax-M2.5' },
    { id: 'MiniMax-M2.1', label: 'MiniMax-M2.1' },
  ],
  directBaseUrl: 'https://api.minimaxi.com/v1',
  directAuthHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  buildDirectRequest: ({ contents, generationConfig, model }) => {
    const messages: { role: string; content: string }[] = [];
    for (const c of contents || []) {
      const text = (c.parts || [])
        .map((p: any) => (p && typeof p.text === 'string' ? p.text : ''))
        .join('');
      const role = c.role === 'model' ? 'assistant' : (c.role || 'user');
      if (text) messages.push({ role, content: text });
    }
    return {
      model,
      messages,
      temperature: (generationConfig as any)?.temperature ?? 0.7,
      top_p: (generationConfig as any)?.topP ?? 1,
      max_tokens: (generationConfig as any)?.maxOutputTokens ?? 4096,
      stream: false,
    };
  },
  extractDirectText: (data) => {
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    return typeof content === 'string' ? content : '';
  },
  isValidApiKeyFormat: (apiKey) => {
    const t = apiKey.trim();
    // MiniMax keys are opaque tokens; we just require non-trivial length
    // and alnum + dash/underscore characters.
    return t.length >= 16 && /^[A-Za-z0-9_\-]+$/.test(t);
  },
  supportsVision: false,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const LLM_PROVIDERS: Record<LLMProviderId, LLMProviderConfig> = {
  gemini: geminiProvider,
  minimax: minimaxProvider,
};
export const LLM_PROVIDER_LIST: LLMProviderConfig[] = [geminiProvider, minimaxProvider];

export function getProvider(id?: string | null): LLMProviderConfig {
  if (!id) return geminiProvider;
  return LLM_PROVIDERS[id as LLMProviderId] || geminiProvider;
}

/**
 * Build the chat URL for a direct browser-side call. MiniMax uses the
 * OpenAI-style /chat/completions endpoint; Gemini keeps its REST shape.
 */
export function buildDirectChatUrl(provider: LLMProviderConfig, model: string): string {
  if (provider.id === 'minimax') {
    return `${provider.directBaseUrl.replace(/\/$/, '')}/chat/completions`;
  }
  return `${provider.directBaseUrl.replace(/\/$/, '')}/${model}:generateContent`;
}
