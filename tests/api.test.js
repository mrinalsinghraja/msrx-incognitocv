/**
 * Tests for api/optimize.js. No framework, no network — `node tests/api.test.js`.
 *
 * The handler is the only server-side code in the product and the only place
 * holding a secret, so its guard rails (method, validation, size cap, rate
 * limit, retry, model fallback, SSE framing) are worth pinning down. Groq is
 * stubbed; nothing here touches the real API or needs a key.
 */

const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'test-key-not-real';
const handler = require('../api/optimize.js');

let passed = 0;
const failures = [];
const queue = [];

// Registered synchronously, run sequentially at the bottom. The rate-limit
// tests share per-instance state, so order has to be deterministic.
function test(name, fn) { queue.push({ name, fn }); }

/* --- Doubles ------------------------------------------------------------- */

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    chunks: [],
    ended: false,
    headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.ended = true; return this; },
    writeHead(code, headers) {
      this.statusCode = code;
      // Node lowercases header names; the mock must too, or a test asserting on
      // 'content-type' silently reads undefined and fails for the wrong reason.
      Object.entries(headers || {}).forEach(([k, v]) => { this.headers[k.toLowerCase()] = v; });
      this.headersSent = true;
      return this;
    },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end() { this.ended = true; return this; },
  };
  return res;
}

const makeReq = (body, headers = {}) => ({ method: 'POST', body, headers: { 'x-forwarded-for': `1.2.3.${Math.random()}`, ...headers } });

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => payload,
  };
}

/** A ReadableStream of Groq-shaped SSE frames, split across chunk boundaries
 *  mid-frame so the handler's buffering is actually exercised. */
function sseResponse(deltas) {
  const frames = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(frames);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= bytes.length) return { done: true, value: undefined };
            const size = 7;   // deliberately tiny: splits frames mid-JSON
            const slice = bytes.slice(offset, offset + size);
            offset += size;
            return { done: false, value: slice };
          },
        };
      },
    },
  };
}

let calls = [];
function stubFetch(sequence) {
  calls = [];
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
}

const GOOD = { resume: 'Amelia Chen, operations manager since 2017.', job: 'Vendor operations manager wanted.' };
const dataFrames = (res) => res.chunks.join('').split('\n\n').filter((l) => l.startsWith('data:'));

/* --- Method and configuration -------------------------------------------- */

test('rejects non-POST', async () => {
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('reports a missing API key as unavailable, not as a bad request', async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(res.statusCode, 503);
  process.env.GROQ_API_KEY = saved;
});

/* --- Validation ---------------------------------------------------------- */

test('requires both inputs', async () => {
  for (const body of [{}, { resume: 'x' }, { job: 'y' }, { resume: '   ', job: 'y' }, { resume: 1, job: 2 }]) {
    const res = makeRes();
    await handler(makeReq(body), res);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('caps input size', async () => {
  const res = makeRes();
  await handler(makeReq({ resume: 'x'.repeat(20001), job: 'y' }), res);
  assert.equal(res.statusCode, 413);
  assert.match(res.body.error, /20,000/);
});

test('survives a missing body object entirely', async () => {
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: undefined }, res);
  assert.equal(res.statusCode, 400);
});

/* --- Model handling ------------------------------------------------------ */

test('ignores an unknown model rather than forwarding it upstream', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: '# Ok' } }] })]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, model: '../../etc/passwd' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].body.model, 'llama-3.3-70b-versatile');
});

test('honours an allowed model', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: '# Ok' } }] })]);
  await handler(makeReq({ ...GOOD, model: 'llama-3.1-8b-instant' }), makeRes());
  assert.equal(calls[0].body.model, 'llama-3.1-8b-instant');
});

test('an unknown mode falls back to the resume prompt', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: '# Ok' } }] })]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, mode: 'evil' }), res);
  assert.equal(res.body.mode, 'resume');
  assert.match(calls[0].body.messages[0].content, /resume optimization engine/);
});

test('cover mode uses the cover-letter prompt', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: 'Dear Hiring Team' } }] })]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, mode: 'cover' }), res);
  assert.equal(res.body.mode, 'cover');
  assert.match(calls[0].body.messages[0].content, /cover letter/i);
});

/* --- Resilience ---------------------------------------------------------- */

test('retries a 429 and succeeds on a later attempt', async () => {
  stubFetch([
    jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }),
    jsonResponse(200, { choices: [{ message: { content: '# Recovered' } }] }),
  ]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, '# Recovered');
  assert.ok(calls.length >= 2, 'should have retried');
});

test('falls back to the smaller model on the last attempt', async () => {
  stubFetch([jsonResponse(500, { error: { message: 'boom' } }, { 'retry-after': '0' })]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(calls.length, 3, 'should have used all attempts');
  assert.equal(calls[calls.length - 1].body.model, 'llama-3.1-8b-instant',
    'the final attempt must drop to the fallback model');
  assert.equal(res.statusCode, 502);
});

test('does not retry a permanent error', async () => {
  stubFetch([jsonResponse(400, { error: { message: 'bad prompt' } })]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(calls.length, 1, '400 is not retriable');
  assert.equal(res.statusCode, 502);
});

test('surfaces upstream rate limiting as 429, not as a generic failure', async () => {
  stubFetch([jsonResponse(429, { error: { message: 'quota' } }, { 'retry-after': '0' })]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(res.statusCode, 429);
});

test('an empty completion is an error, not a blank resume', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: '   ' } }] })]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(res.statusCode, 502);
});

test('a thrown network error becomes a 504 rather than an unhandled rejection', async () => {
  stubFetch([() => { throw new Error('ECONNRESET'); }]);
  const res = makeRes();
  await handler(makeReq(GOOD), res);
  assert.equal(res.statusCode, 504);
});

/* --- Streaming ----------------------------------------------------------- */

test('streams deltas as its own protocol and terminates with [DONE]', async () => {
  stubFetch([sseResponse(['# Amelia', ' Chen\n', 'contact line'])]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, stream: true }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.ok(res.ended, 'the stream must be closed');

  const frames = dataFrames(res);
  assert.equal(frames[frames.length - 1], 'data: [DONE]');

  const text = frames
    .map((f) => f.slice(5).trim())
    .filter((p) => p !== '[DONE]')
    .map((p) => JSON.parse(p))
    .filter((o) => o.delta)
    .map((o) => o.delta)
    .join('');
  assert.equal(text, '# Amelia Chen\ncontact line', 'frames split mid-JSON must still reassemble');
});

test('the first stream frame announces which model actually ran', async () => {
  stubFetch([sseResponse(['x'])]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, stream: true, model: 'llama-3.1-8b-instant' }), res);
  const first = JSON.parse(dataFrames(res)[0].slice(5).trim());
  assert.equal(first.meta.model, 'llama-3.1-8b-instant');
  assert.equal(first.meta.mode, 'resume');
});

test('an empty stream reports an error instead of finishing silently', async () => {
  stubFetch([sseResponse([])]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, stream: true }), res);
  const payloads = dataFrames(res).map((f) => f.slice(5).trim());
  assert.ok(payloads.some((p) => p !== '[DONE]' && JSON.parse(p).error), 'should emit an error frame');
});

test('an upstream failure before the stream opens is a JSON error, not a broken stream', async () => {
  stubFetch([jsonResponse(503, { error: { message: 'unavailable' } }, { 'retry-after': '0' })]);
  const res = makeRes();
  await handler(makeReq({ ...GOOD, stream: true }), res);
  assert.equal(res.headersSent, false, 'must not have opened an event-stream');
  assert.equal(res.statusCode, 502);
  assert.ok(res.body.error);
});

/* --- Rate limiting ------------------------------------------------------- */

test('rate limits a single client without affecting others', async () => {
  stubFetch([jsonResponse(200, { choices: [{ message: { content: '# Ok' } }] })]);
  const ip = '9.9.9.9';
  let limited = 0;
  for (let i = 0; i < 20; i += 1) {
    const res = makeRes();
    await handler({ method: 'POST', body: GOOD, headers: { 'x-forwarded-for': ip } }, res);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited > 0, 'a client hammering the endpoint should eventually be limited');

  const other = makeRes();
  await handler({ method: 'POST', body: GOOD, headers: { 'x-forwarded-for': '8.8.8.8' } }, other);
  assert.equal(other.statusCode, 200, 'a different client must not be caught by it');
});

test('a limited response tells the caller when to come back', async () => {
  const ip = '7.7.7.7';
  let res;
  for (let i = 0; i < 20; i += 1) {
    res = makeRes();
    await handler({ method: 'POST', body: GOOD, headers: { 'x-forwarded-for': ip } }, res);
    if (res.statusCode === 429) break;
  }
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '60');
});

/* --- Privacy ------------------------------------------------------------- */

test('never writes request content to the console', async () => {
  const seen = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a) => seen.push(a.join(' '));
  console.log = (...a) => seen.push(a.join(' '));

  stubFetch([() => { throw new Error('ECONNRESET'); }]);
  const secret = 'CONFIDENTIAL-SALARY-AND-HOME-ADDRESS';
  await handler(makeReq({ resume: `Amelia Chen ${secret}`, job: `Also ${secret}` }), makeRes());

  console.error = realError;
  console.log = realLog;

  const joined = seen.join('\n');
  assert.ok(!joined.includes(secret), `request content leaked into logs:\n${joined}`);
  assert.ok(!joined.includes('Amelia'), 'candidate name leaked into logs');
});

/* --- Report -------------------------------------------------------------- */

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push({ name, err });
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} failing, ${passed} passing\n`);
    failures.forEach(({ name, err }) => {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message.split('\n')[0]}`);
    });
    process.exit(1);
  }
  console.log(`${passed} passing`);
})();
