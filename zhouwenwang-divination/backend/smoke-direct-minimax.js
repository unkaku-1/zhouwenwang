#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Direct-to-MiniMax smoke test — bypasses our local backend entirely and
 * calls the MiniMax Chat Completions API directly. This proves the request
 * body shape and response parsing are correct against the real upstream.
 *
 * Usage:
 *   MINIMAX_API_KEY=eyJ... node smoke-direct-minimax.js
 *
 * This is the "honest MiniMax round-trip" the user asked for: a qimen
 * prompt sent to MiniMax-M2.7 and a non-empty Chinese text response.
 */

'use strict';

const https = require('https');
const { URL } = require('url');

const API_KEY = process.env.MINIMAX_API_KEY;
if (!API_KEY) {
  console.error('MINIMAX_API_KEY env var is required');
  process.exit(1);
}

// Same model the user-facing app exposes in the model picker.
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';

const QIMEN_PROMPT = `你是周文王，精通奇门遁甲。请根据以下盘面，给出简洁的趋势解读。

盘面：
时家奇门 · 阳遁 7 局
值符：天蓬  值使：休门
落宫：坎一宫
天盘干：丁  地盘干：壬
八神：六合  八门：休门  九星：天蓬
空亡：戌亥  马星：巳

请用中文给出 2 句话的解读：当前时机如何？建议如何行动？`;

const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: QIMEN_PROMPT }],
  temperature: 0.7,
  max_tokens: 1024,
});

const url = new URL('https://api.minimaxi.com/v1/chat/completions');

const req = https.request(
  {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 120000,
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      console.log(`status: ${res.statusCode}`);
      if (res.statusCode !== 200) {
        console.error('error body:', text.slice(0, 1000));
        process.exit(1);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('non-JSON response:', text.slice(0, 500));
        process.exit(1);
      }
      const content = data.choices?.[0]?.message?.content || '';
      console.log(`model: ${data.model}`);
      console.log(`content length: ${content.length} chars`);
      console.log('--- preview ---');
      console.log(content.slice(0, 600));
      console.log('--------------');
      if (!content) {
        console.error('FAIL: empty content');
        process.exit(1);
      }
      if (!/[\u4e00-\u9fff]/.test(content)) {
        console.error('FAIL: response contains no Chinese characters');
        process.exit(1);
      }
      const hits = ['坎', '休', '天蓬', '丁', '壬', '奇门', '时机', '行动'].filter((w) => content.includes(w));
      if (hits.length < 1) {
        console.error('FAIL: no qimen-specific terms in response (this is a soft heuristic, but worth checking)');
        process.exit(1);
      }
      console.log(`\nOK: Chinese text response, qimen terms: ${hits.join(', ')}`);
    });
  }
);
req.on('error', (e) => {
  console.error('request error:', e.message);
  process.exit(1);
});
req.write(body);
req.end();
