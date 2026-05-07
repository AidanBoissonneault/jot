import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotionRequester } from '../src/notionRequest.js';

test('notionRequest sends requests no faster than configured limiter cadence', async () => {
  let time = 0;
  const requestTimes = [];
  const request = createNotionRequester({
    fetchImpl: async () => {
      requestTimes.push(time);
      return jsonResponse(200, { ok: true });
    },
    notionVersion: 'test-version',
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    requestsPerSecond: 3,
  });

  await request(testStore(), '/one');
  await request(testStore(), '/two');
  await request(testStore(), '/three');

  assert.equal(requestTimes[0], 0);
  assert.ok(requestTimes[1] - requestTimes[0] >= 1_000 / 3);
  assert.ok(requestTimes[2] - requestTimes[1] >= 1_000 / 3);
});

test('notionRequest retries 429 rate_limited after Retry-After', async () => {
  let time = 0;
  const sleeps = [];
  let calls = 0;
  const request = createNotionRequester({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { code: 'rate_limited', message: 'Slow down.' }, { 'Retry-After': '2' })
        : jsonResponse(200, { ok: true });
    },
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    requestsPerSecond: 1_000,
  });

  const payload = await request(testStore(), '/pages');

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('notionRequest retries transient network and Notion 5xx failures', async () => {
  let time = 0;
  const sleeps = [];
  let calls = 0;
  const request = createNotionRequester({
    fetchImpl: async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error('socket hang up');
      }

      if (calls === 2) {
        return jsonResponse(503, { code: 'service_unavailable', message: 'Try again.' });
      }

      return jsonResponse(200, { ok: true });
    },
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    requestsPerSecond: 1_000,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
  });

  const payload = await request(testStore(), '/blocks');

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test('notionRequest does not retry permanent Notion errors', async () => {
  let calls = 0;
  const request = createNotionRequester({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(400, { code: 'validation_error', message: 'Bad request.' });
    },
    sleep: async () => {
      throw new Error('Permanent errors should not sleep before retrying.');
    },
  });

  await assert.rejects(
    request(testStore(), '/pages'),
    (error) => error.status === 400 && error.code === 'validation_error',
  );
  assert.equal(calls, 1);
});

function testStore() {
  return { tokens: { access_token: 'secret' } };
}

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] ?? headers[name.toLowerCase()];
      },
    },
    async json() {
      return payload;
    },
  };
}
