#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * REAL upstream smoke test — points our backend at api.minimaxi.com
 * and verifies a qimen prompt flows through.
 *
 * Requires MINIMAX_API_KEY env var. Set the backend's env to the same
 * key (run server.js with MINIMAX_API_KEY=... in the same shell, or
 * put it in backend/.env).
 *
 * Run AFTER the backend is already up on http://127.0.0.1:3001.
 */

'use strict';

const http = require('http');

const ZWW = 'http://127.0.0.1:3001';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(
      `${ZWW}${path}`,
      { method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(c, m) { if (!c) { console.error(`  ✗ ${m}`); throw new Error(m); } console.log(`  ✓ ${m}`); }

const QIMEN_PROMPT = `你是周文王，精通奇门遁甲。请根据以下盘面，给出简洁的趋势解读。

盘面：
时家奇门 · 阳遁 7 局
值符：天蓬  值使：休门
落宫：坎一宫
天盘干：丁  地盘干：壬
八神：六合  八门：休门  九星：天蓬
空亡：戌亥  马星：巳

请用中文给出 2 句话的解读：当前时机如何？建议如何行动？`;

async function main() {
  console.log('[1/3] provider reports real key configured');
  let r = await req('GET', '/api/llm/providers');
  assert(r.status === 200, '200');
  const mini = r.json.providers.find((p) => p.id === 'minimax');
  assert(mini.keyConfigured === true, `minimax.keyConfigured = true (env in backend = ${process.env.MINIMAX_API_KEY ? 'set' : 'NOT SET'})`);

  console.log('\n[2/3] /api/llm/generate → real api.minimaxi.com → Chinese qimen text');
  r = await req('POST', '/api/llm/generate', {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    contents: [{ role: 'user', parts: [{ text: QIMEN_PROMPT }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });
  assert(r.status === 200, `status = 200 (got ${r.status})`);
  if (r.status !== 200) {
    console.error('  body:', (r.json ? JSON.stringify(r.json) : r.text).slice(0, 800));
    return;
  }
  assert(r.json.provider === 'minimax', 'provider = minimax');
  const text = (r.json.text || '').trim();
  assert(text.length > 100, `text length > 100 (got ${text.length})`);
  assert(/[\u4e00-\u9fff]/.test(text), 'text contains Chinese');
  const hits = ['坎', '休', '天蓬', '丁', '壬', '奇门', '时机', '行动'].filter((w) => text.includes(w));
  assert(hits.length >= 3, `qimen terms (got: ${hits.join(',') || 'none'}, want >=3)`);
  console.log(`  -- preview: ${text.slice(0, 200).replace(/\n/g, ' ')}…`);

  console.log('\n[3/3] /api/llm/validate-key authenticates against real upstream');
  r = await req('POST', '/api/llm/validate-key', {
    provider: 'minimax',
    apiKey: process.env.MINIMAX_API_KEY,
  });
  assert(r.status === 200, `validate-key 200 (got ${r.status})`);
  assert(r.json.valid === true, `valid = true (got ${JSON.stringify(r.json).slice(0, 200)})`);

  console.log('\nREAL-UPSTREAM SMOKE OK');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });