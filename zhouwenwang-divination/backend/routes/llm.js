/**
 * Provider-routed LLM routes.
 *
 * Exposes:
 *   GET  /api/llm/providers        list available providers + key status
 *   POST /api/llm/generate         text generation (non-streaming)
 *   POST /api/llm/stream           text generation (SSE, OpenAI-style deltas)
 *   POST /api/llm/validate-key     validate an API key against the upstream
 *
 * The frontend chooses a provider per request via the `provider` field. The
 * backend normalizes the Gemini-style request body, dispatches to the right
 * upstream, and normalizes the response back into a Gemini-shaped envelope
 * so the existing client code can keep working without a per-provider fork.
 */

'use strict';

const express = require('express');
const axios = require('axios');
const { getProvider, resolveApiKey, extractError, listProviders } = require('../providers/registry');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/llm/providers
// ---------------------------------------------------------------------------

router.get('/providers', (req, res) => {
  const providers = listProviders().map((p) => ({
    ...p,
    keyConfigured: !!process.env[p.envKey],
  }));
  res.json({ providers, defaultProvider: 'gemini' });
});

// ---------------------------------------------------------------------------
// POST /api/llm/generate
//
// Request body (Gemini-shaped; the original client code uses this):
//   {
//     provider: 'gemini' | 'minimax',
//     apiKey: '<optional override>',
//     model: 'gemini-3-pro-preview' | 'MiniMax-M2.7' | ...,
//     systemPrompt?: 'override system message',
//     contents: [{ role: 'user'|'model', parts: [{ text }] }],
//     generationConfig: { temperature, topP, topK, maxOutputTokens }
//   }
//
// Response (Gemini-shaped):
//   { provider, model, text, candidates: [{ content: { parts: [{ text }] }], raw }
//
// `text` is the convenience field for the frontend; `candidates` mirrors the
// Gemini response so existing client code that reads
// data.candidates[0].content.parts[0].text still works.
// ---------------------------------------------------------------------------

router.post('/generate', async (req, res) => {
  const { provider: providerId, apiKey, model, contents, generationConfig, systemPrompt } = req.body || {};

  const provider = getProvider(providerId);
  if (!provider) {
    return res.status(400).json({
      error: `Unknown LLM provider: ${providerId}. Available: ${listProviders().map((p) => p.id).join(', ')}`,
      code: 'UNKNOWN_PROVIDER',
    });
  }
  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: 'contents is required and must be a non-empty array', code: 'BAD_REQUEST' });
  }

  const key = resolveApiKey(provider, apiKey);
  if (!key) {
    return res.status(401).json({
      error: `${provider.displayName} API key not configured. Set ${provider.envKey} or pass apiKey in the request.`,
      code: 'API_KEY_MISSING',
    });
  }

  const url = provider.buildChatUrl(model, 'generateContent');
  const body = provider.buildRequest({ contents, generationConfig, systemPrompt, model });

  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        ...provider.authHeader(key),
      },
      timeout: 120000,
    });
    const text = provider.extractText(response.data) || '';
    res.json({
      provider: provider.id,
      model: body.model,
      text,
      candidates: [{ content: { parts: [{ text }] } }],
      raw: response.data,
    });
  } catch (err) {
    const e = extractError(provider, err);
    console.error(`[${provider.id}] generate error:`, e.status, e.code, e.message);
    res.status(e.status || 502).json({ error: e.message, code: e.code, provider: provider.id });
  }
});

// ---------------------------------------------------------------------------
// POST /api/llm/stream
//
// SSE streaming. Emits a stream of `data: {content, done}` events in the
// same shape the existing /api/gemini/stream uses, so the frontend doesn't
// need to learn a new protocol per provider.
// ---------------------------------------------------------------------------

router.post('/stream', async (req, res) => {
  const { provider: providerId, apiKey, model, prompt, systemPrompt, maxTokens = 4096 } = req.body || {};

  const provider = getProvider(providerId);
  if (!provider) {
    return res.status(400).json({ error: `Unknown LLM provider: ${providerId}`, code: 'UNKNOWN_PROVIDER' });
  }
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required', code: 'BAD_REQUEST' });
  }

  const key = resolveApiKey(provider, apiKey);
  if (!key) {
    return res.status(401).json({
      error: `${provider.displayName} API key not configured. Set ${provider.envKey} or pass apiKey in the request.`,
      code: 'API_KEY_MISSING',
    });
  }

  // Always non-stream at the network layer for v1 of this route; the
  // frontend can simulate streaming by chunking the response. We deliberately
  // keep the protocol identical to the existing /api/gemini/stream SSE shape.
  const url = provider.buildChatUrl(model, 'generateContent');
  const body = provider.buildRequest({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
    systemPrompt,
    model,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const startTime = Date.now();
  const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        ...provider.authHeader(key),
      },
      timeout: 120000,
    });
    const text = provider.extractText(response.data) || '';
    // Emit the full text in a single delta for backward compatibility with
    // the existing /api/gemini/stream consumer in src/masters/service.ts.
    if (text) {
      sendEvent({ content: text, done: false, timestamp: Date.now() });
    }
    sendEvent({ content: '', done: true, totalLength: text.length, totalTime: Date.now() - startTime, provider: provider.id });
  } catch (err) {
    const e = extractError(provider, err);
    console.error(`[${provider.id}] stream error:`, e.status, e.code, e.message);
    sendEvent({ error: e.message, code: e.code, done: true, provider: provider.id });
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/llm/validate-key
// ---------------------------------------------------------------------------

router.post('/validate-key', async (req, res) => {
  const { provider: providerId, apiKey } = req.body || {};
  const provider = getProvider(providerId);
  if (!provider) {
    return res.status(400).json({ error: `Unknown LLM provider: ${providerId}`, code: 'UNKNOWN_PROVIDER' });
  }
  const key = resolveApiKey(provider, apiKey);
  if (!key) {
    return res.status(401).json({ error: `${provider.displayName} API key not provided`, code: 'API_KEY_MISSING' });
  }

  // Provider-specific validation. We aim for a single cheap call that
  // confirms the key works. Different providers expose different probes.
  try {
    if (provider.id === 'minimax') {
      // OpenAI-style: hit /models with the key; 200 means key is valid.
      const url = `${provider.baseUrl.replace(/\/$/, '')}/models`;
      const response = await axios.get(url, {
        headers: { ...provider.authHeader(key) },
        timeout: 10000,
      });
      if (response.status === 200) {
        return res.json({ valid: true, provider: provider.id });
      }
      return res.status(502).json({ error: 'Unexpected response from upstream', code: 'UPSTREAM_ERROR' });
    }
    if (provider.id === 'gemini') {
      const url = `${provider.baseUrl}?key=${encodeURIComponent(key)}`;
      const response = await axios.get(url, { timeout: 10000 });
      if (response.status === 200) {
        return res.json({ valid: true, provider: provider.id });
      }
      return res.status(502).json({ error: 'Unexpected response from upstream', code: 'UPSTREAM_ERROR' });
    }
    return res.status(400).json({ error: 'Provider has no validation probe', code: 'NOT_IMPLEMENTED' });
  } catch (err) {
    const e = extractError(provider, err);
    return res.status(e.status || 502).json({ valid: false, error: e.message, code: e.code, provider: provider.id });
  }
});

module.exports = router;
