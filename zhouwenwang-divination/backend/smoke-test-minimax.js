#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Smoke test for the feature/minimax-provider backend.
 *
 * Three checks, each is a REAL HTTP round-trip against the local backend:
 *
 *   1. /api/llm/providers lists BOTH gemini and minimax.
 *   2. /api/llm/generate with provider=minimax and no key returns 401
 *      with code=API_KEY_MISSING — proves the routing layer is wired.
 *   3. /api/llm/generate with provider=minimax and a real MINIMAX_API_KEY
 *      returns a non-empty Chinese text response for a qimen-style prompt.
 *
 * Check 3 is the "real MiniMax round-trip" — it will only run if
 * MINIMAX_API_KEY is set in the environment. The script exits with
 * non-zero if any check fails. Exit code 0 means the provider is wired
 * end-to-end.
 */

'use strict';

const http = require('http');

const PORT = process.env.SMOKE_PORT || 3001;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

function request(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* keep text as-is */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

// A representative qimen prompt that the app would actually send.
// Modeled on the prompt that src/games/qimen/QiMenPage.tsx builds through
// buildPrompt() in service.ts — kept short so the smoke test runs in
// seconds, not minutes.
const QIMEN_PROMPT = `你是周文王，精通奇门遁甲。请根据以下盘面，给出简洁的趋势解读。

盘面：
时家奇门 · 阳遁 7 局
值符：天蓬  值使：休门
落宫：坎一宫
天盘干：丁  地盘干：壬
八神：六合  八门：休门  九星：天蓬
空亡：戌亥  马星：巳

请用中文给出 2 句话的解读：当前时机如何？建议如何行动？`;

async function checkHealth() {
  console.log('\n[1/3] Health check');
  const r = await request('/api/health', 'GET');
  assert(r.status === 200, `/api/health returns 200 (got ${r.status})`);
  assert(r.json && r.json.status === 'ok', '/api/health body has status=ok');
}

async function checkProvidersList() {
  console.log('\n[2/3] /api/llm/providers lists gemini + minimax');
  const r = await request('/api/llm/providers', 'GET');
  assert(r.status === 200, `/api/llm/providers returns 200 (got ${r.status})`);
  const ids = (r.json.providers || []).map((p) => p.id);
  assert(ids.includes('gemini'), 'gemini present');
  assert(ids.includes('minimax'), 'minimax present');
  const minimax = r.json.providers.find((p) => p.id === 'minimax');
  assert(minimax.envKey === 'MINIMAX_API_KEY', 'minimax env key = MINIMAX_API_KEY');
  assert(
    (minimax.keyConfigured === true) === !!process.env.MINIMAX_API_KEY,
    `minimax.keyConfigured reflects env (${minimax.keyConfigured})`
  );
}

async function checkMissingKey() {
  console.log('\n[3a/3] provider=minimax without key returns 401 API_KEY_MISSING');
  const r = await request('/api/llm/generate', 'POST', {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  assert(r.status === 401, `status = 401 (got ${r.status})`);
  assert(r.json && r.json.code === 'API_KEY_MISSING', 'code = API_KEY_MISSING');
  assert(/MiniMax/.test(r.json.error || ''), 'error message mentions MiniMax');
}

async function checkRealRoundTrip() {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) {
    console.log('\n[3b/3] Real MiniMax round-trip: SKIPPED (MINIMAX_API_KEY not set)');
    console.log('  set MINIMAX_API_KEY in env to run the end-to-end check');
    return;
  }
  console.log('\n[3b/3] Real MiniMax round-trip: posting a qimen prompt');
  const r = await request('/api/llm/generate', 'POST', {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    contents: [{ role: 'user', parts: [{ text: QIMEN_PROMPT }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });
  assert(r.status === 200, `status = 200 (got ${r.status})`);
  if (r.status !== 200) {
    console.error('  body:', JSON.stringify(r.json || r.text).slice(0, 500));
    return;
  }
  assert(r.json.provider === 'minimax', 'response.provider = minimax');
  const text = (r.json.text || '').trim();
  assert(text.length > 0, 'response.text is non-empty');
  console.log(`  -- text length: ${text.length} chars`);
  console.log(`  -- preview: ${text.slice(0, 80).replace(/\n/g, ' ')}…`);
  // Chinese presence: at least one CJK Unified Ideograph
  assert(/[\u4e00-\u9fff]/.test(text), 'response.text contains Chinese characters');
  // L1 sanity: a qimen answer for "天蓬+休门+丁+壬+坎一" should mention
  // at least one of: 坎, 休, 天蓬, 丁, 壬, 奇门, or 时机. This is
  // a loose heuristic, not a strict assertion.
  const hits = ['坎', '休', '天蓬', '丁', '壬', '奇门', '时机', '行动'].filter((w) => text.includes(w));
  assert(hits.length >= 1, `qimen answer mentions a relevant term (got: ${hits.join(',') || 'none'})`);
}

async function main() {
  console.log(`Smoke test against ${BASE}`);
  let failed = false;
  for (const step of [checkHealth, checkProvidersList, checkMissingKey, checkRealRoundTrip]) {
    try {
      await step();
    } catch (e) {
      failed = true;
      console.error(`  step failed: ${e.message}`);
    }
  }
  if (failed) {
    console.error('\nSMOKE FAILED');
    process.exit(1);
  }
  console.log('\nSMOKE OK');
}

main().catch((e) => {
  console.error('unhandled:', e);
  process.exit(1);
});
