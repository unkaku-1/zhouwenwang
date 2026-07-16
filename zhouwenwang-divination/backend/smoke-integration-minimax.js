#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Full integration smoke test for /api/llm/* routes.
 *
 * What this proves:
 *   1. Our backend (backend/server.js) accepts a Gemini-style request at
 *      /api/llm/generate with provider=minimax.
 *   2. It translates that request to the OpenAI / chat-completions shape
 *      and forwards it to MINIMAX_BASE_URL.
 *   3. It translates the upstream response BACK into the Gemini envelope
 *      (text + candidates[0].content.parts[0].text) so the existing
 *      client code can consume it unchanged.
 *
 * How: we point our backend at a tiny fake "MiniMax" server we run
 * ourselves. The fake server captures the request body and returns a
 * canned OpenAI-shape response. Our backend then has to re-shape it.
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FAKE_PORT = 39123;
const ZWW_PORT = 39124;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`;

let fakeServer = null;
let zwwServer = null;

function startFakeMiniMax() {
  return new Promise((resolve, reject) => {
    let capturedRequest = null;
    fakeServer = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          capturedRequest = body;
          // Auth check
          const auth = req.headers.authorization || '';
          if (!auth.startsWith('Bearer test-key-123')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid api key', code: 'invalid_key' } }));
            return;
          }
          // Return a fake OpenAI-shape response with a Chinese qimen answer
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'fake-1',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content:
                      '当前奇门局天蓬星落坎宫休门，主休息蓄势、不可冒进。' +
                      '天盘丁奇加地盘壬水，癸水生木有情，宜守不宜攻，宜静待贵人相助。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            })
          );
        });
        return;
      }
      if (req.url === '/v1/models' && req.method === 'GET') {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer test-key-123')) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M2.5' }] }));
        return;
      }
      res.writeHead(404).end();
    });
    fakeServer.listen(FAKE_PORT, '127.0.0.1', () => {
      fakeServer.capturedRequest = () => capturedRequest;
      resolve();
    });
    fakeServer.on('error', reject);
  });
}

function startZwwBackend() {
  return new Promise((resolve, reject) => {
    // Make sure no leftover .env interferes
    const env = {
      ...process.env,
      PORT: String(ZWW_PORT),
      MINIMAX_API_KEY: 'test-key-123',
      MINIMAX_BASE_URL: `${FAKE_BASE}/v1`,
      NODE_ENV: 'test',
    };
    delete env.GEMINI_API_KEY;

    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    zwwServer = child;
    let resolved = false;
    const onData = (buf) => {
      const text = buf.toString('utf-8');
      process.stdout.write(`  [zww] ${text}`);
      if (!resolved && /服务已启动|服务地址/.test(text)) {
        resolved = true;
        setTimeout(resolve, 200);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => process.stdout.write(`  [zww ERR] ${b.toString('utf-8')}`));
    child.on('exit', (code) => {
      if (!resolved) reject(new Error(`zww backend exited early (code=${code})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('zww backend startup timeout'));
    }, 8000);
  });
}

function http1(method, host, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      { method, host, port, path, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* keep text */
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

async function main() {
  console.log('--- Setting up: fake MiniMax server on :' + FAKE_PORT);
  await startFakeMiniMax();
  console.log('--- Starting zhouwenwang backend on :' + ZWW_PORT + ' (pointed at fake)');
  await startZwwBackend();

  const ZWW = `http://127.0.0.1:${ZWW_PORT}`;
  console.log('\n[A] /api/llm/providers reports minimax as configured');
  let r = await http1('GET', '127.0.0.1', ZWW_PORT, '/api/llm/providers');
  assert(r.status === 200, 'providers 200');
  const mini = r.json.providers.find((p) => p.id === 'minimax');
  assert(mini.keyConfigured === true, 'minimax.keyConfigured = true (env was set)');

  console.log('\n[B] /api/llm/generate routes Gemini-style request to MiniMax');
  r = await http1('POST', '127.0.0.1', ZWW_PORT, '/api/llm/generate', {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    contents: [{ role: 'user', parts: [{ text: '请用中文回答：现在天蓬星落坎宫是什么意思？' }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
  });
  assert(r.status === 200, `status = 200 (got ${r.status}: ${r.text?.slice(0, 200)})`);
  if (r.status !== 200) return;
  assert(r.json.provider === 'minimax', 'response.provider = minimax');
  assert(r.json.model === 'MiniMax-M2.7', 'response.model = MiniMax-M2.7');
  assert(typeof r.json.text === 'string' && r.json.text.length > 0, 'response.text is non-empty');
  assert(/[\u4e00-\u9fff]/.test(r.json.text), 'response.text contains Chinese');
  assert(
    r.json.candidates?.[0]?.content?.parts?.[0]?.text === r.json.text,
    'response.candidates[0].content.parts[0].text mirrors text (Gemini envelope)'
  );

  console.log('\n[C] The fake server received the correctly-shaped request');
  const captured = fakeServer.capturedRequest();
  assert(captured !== null, 'fake server captured a request');
  assert(captured.model === 'MiniMax-M2.7', 'fake received model = MiniMax-M2.7');
  assert(Array.isArray(captured.messages), 'fake received messages[]');
  assert(captured.messages[0].role === 'user', 'fake received role=user');
  assert(
    captured.messages[0].content.includes('天蓬星落坎宫'),
    'fake received the original prompt text'
  );
  assert(captured.max_tokens === 512, 'fake received max_tokens=512');
  assert(captured.temperature === 0.7, 'fake received temperature=0.7');

  console.log('\n[D] /api/llm/validate-key works against the upstream');
  r = await http1('POST', '127.0.0.1', ZWW_PORT, '/api/llm/validate-key', {
    provider: 'minimax',
    apiKey: 'test-key-123',
  });
  assert(r.status === 200, 'validate-key 200');
  assert(r.json.valid === true, 'validate-key returned valid=true');

  console.log('\n[E] /api/llm/stream emits SSE in the same shape the existing client uses');
  r = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      prompt: '天盘丁加地盘壬怎么解读？',
    });
    const req = http.request(
      { method: 'POST', host: '127.0.0.1', port: ZWW_PORT, path: '/api/llm/stream',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  assert(r.status === 200, `stream status 200 (got ${r.status})`);
  const events = r.text
    .split('\n\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('data: '))
    .map((s) => {
      try { return JSON.parse(s.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
  assert(events.length >= 2, `at least 2 SSE events (got ${events.length})`);
  const last = events[events.length - 1];
  assert(last.done === true, 'last event has done=true');
  const textEvent = events.find((e) => e.content);
  assert(textEvent && /[\u4e00-\u9fff]/.test(textEvent.content), 'text event contains Chinese');
  console.log(`  -- text event length: ${textEvent.content.length} chars`);

  console.log('\nALL CHECKS PASSED');
}

async function cleanup() {
  if (zwwServer) {
    try {
      zwwServer.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  if (fakeServer) {
    try {
      fakeServer.close();
    } catch {
      /* ignore */
    }
  }
}

main()
  .then(() => cleanup())
  .catch((e) => {
    console.error('FAIL:', e.message);
    cleanup();
    setTimeout(() => process.exit(1), 500);
  });
