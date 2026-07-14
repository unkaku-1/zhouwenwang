/**
 * LLM Provider registry
 *
 * Centralizes per-provider configuration and request/response mapping so the
 * backend can serve multiple LLM backends behind a single /api/llm/* surface.
 *
 * Each provider entry exposes:
 *   id              stable identifier (gemini, minimax, openai, ...)
 *   displayName     human-friendly name shown in UI
 *   envKey          env var name holding the API key
 *   apiKeyPrefixes  optional list of accepted key prefixes (informational,
 *                   validated by isValidApiKeyFormat)
 *   baseUrl         API root
 *   buildChatUrl()  builds the chat/completions URL
 *   authHeader()    returns the Authorization header value for a key
 *   buildRequest()  normalizes a Gemini-style { contents, generationConfig }
 *                   payload into the provider's native body
 *   extractText()   pulls the text content out of the provider's response
 *   supportsStreaming
 */

'use strict';

// ---------------------------------------------------------------------------
// Gemini (default, kept for back-compat)
// ---------------------------------------------------------------------------

const geminiProvider = {
  id: 'gemini',
  displayName: 'Google Gemini',
  envKey: 'GEMINI_API_KEY',
  apiKeyPrefixes: ['AIza'],
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  supportsStreaming: true,
  buildChatUrl: (model) => `${geminiProvider.baseUrl}/${model}:generateContent`,
  authHeader: (apiKey) => ({ 'x-goog-api-key': apiKey }),
  buildRequest: ({ contents, generationConfig }) => {
    const cfg = { temperature: 0.7, topK: 32, topP: 1, maxOutputTokens: 4096, ...(generationConfig || {}) };
    return { contents, generationConfig: cfg };
  },
  extractText: (data) => {
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) return '';
    const part = cand.content && cand.content.parts && cand.content.parts[0];
    return (part && part.text) || '';
  },
};

// ---------------------------------------------------------------------------
// MiniMax (OpenAI-compatible, China endpoint by default)
// ---------------------------------------------------------------------------
//
// Docs:
//   China:  https://api.minimaxi.com/v1
//   Global: https://api.minimax.io/v1
// Auth:    Authorization: Bearer <key>
// Models:  MiniMax-M3 (current default), MiniMax-M2.7, MiniMax-M2.5,
//          MiniMax-M2.1, MiniMax-M2
// Body:    { model, messages: [{role, content}], temperature, max_tokens,
//           stream }
// Response (non-streaming):
//   { choices: [{ message: { role, content }, finish_reason, index }], ... }

const MINIMAX_DEFAULT_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';

const minimaxProvider = {
  id: 'minimax',
  displayName: 'MiniMax (MiniMax)',
  envKey: 'MINIMAX_API_KEY',
  // MiniMax keys are arbitrary-length opaque tokens. We accept any token
  // that's at least 16 characters and made of [A-Za-z0-9_-] so we don't
  // reject users mid-typing.
  apiKeyPrefixes: [],
  baseUrl: MINIMAX_DEFAULT_BASE,
  supportsStreaming: true,
  buildChatUrl: () => `${MINIMAX_DEFAULT_BASE}/chat/completions`,
  authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  buildRequest: ({ contents, generationConfig, systemPrompt, model }) => {
    const messages = [];
    if (systemPrompt && typeof systemPrompt === 'string') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    // Gemini `contents` is [{ role, parts: [{text}] }]; flatten it to
    // OpenAI-style messages.
    for (const c of contents || []) {
      const text = (c.parts || []).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      const role = c.role === 'model' ? 'assistant' : (c.role || 'user');
      if (text) messages.push({ role, content: text });
    }
    const cfg = generationConfig || {};
    const body = {
      model: model || 'MiniMax-M2.7',
      messages,
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.7,
      top_p: typeof cfg.topP === 'number' ? cfg.topP : 1,
      max_tokens: cfg.maxOutputTokens || 4096,
      stream: false,
    };
    return body;
  },
  extractText: (data) => {
    const choice = data && data.choices && data.choices[0];
    if (!choice) return '';
    const msg = choice.message || {};
    return typeof msg.content === 'string' ? msg.content : '';
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDERS = {
  [geminiProvider.id]: geminiProvider,
  [minimaxProvider.id]: minimaxProvider,
};

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    envKey: p.envKey,
    supportsStreaming: p.supportsStreaming,
  }));
}

function getProvider(id) {
  if (!id) return geminiProvider; // safe default
  return PROVIDERS[id] || null;
}

/**
 * Pick an API key for the provider. Order of precedence:
 *   1. explicit `apiKey` argument (from request body / header)
 *   2. process.env[p.envKey]
 * Returns null if neither yields a usable key.
 */
function resolveApiKey(provider, explicit) {
  if (explicit && typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const envVal = process.env[provider.envKey];
  if (envVal && envVal.trim().length > 0) return envVal.trim();
  return null;
}

/**
 * Translate a provider's HTTP error (axios error.response.data) into a flat
 * `{ message, code }` so the frontend error path can show it without
 * knowing the provider's payload shape.
 */
function extractError(provider, err) {
  const data = err && err.response && err.response.data;
  if (!data) {
    return {
      message: (err && err.message) || `${provider.displayName} request failed`,
      code: 'UPSTREAM_ERROR',
      status: (err && err.response && err.response.status) || 502,
    };
  }
  // OpenAI-shaped errors: { error: { message, code, type } }
  if (data.error && typeof data.error === 'object') {
    return {
      message: data.error.message || `${provider.displayName} error`,
      code: data.error.code || data.error.type || 'UPSTREAM_ERROR',
      status: err.response.status,
    };
  }
  // OpenAI-shaped errors (string form): { error: "..." }
  if (typeof data.error === 'string') {
    return { message: data.error, code: 'UPSTREAM_ERROR', status: err.response.status };
  }
  // Gemini-shaped errors: { error: { code, message, status } }
  if (data.error && data.error.message) {
    return {
      message: data.error.message,
      code: data.error.code || data.error.status || 'UPSTREAM_ERROR',
      status: err.response.status,
    };
  }
  return {
    message: typeof data === 'string' ? data : JSON.stringify(data),
    code: 'UPSTREAM_ERROR',
    status: err.response.status,
  };
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  resolveApiKey,
  extractError,
};
