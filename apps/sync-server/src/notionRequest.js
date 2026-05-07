const DEFAULT_REQUESTS_PER_SECOND = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 2_000;

export function createNotionRequester({
  baseUrl = 'https://api.notion.com/v1',
  fetchImpl = globalThis.fetch,
  notionVersion,
  requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required for Notion requests.');
  }

  const limiter = createRateLimiter({
    requestsPerSecond,
    sleep,
    now,
  });

  return async function notionRequest(store, endpoint, init = {}) {
    let attempt = 0;

    while (true) {
      await limiter.waitForTurn();

      try {
        const response = await fetchImpl(`${baseUrl}${endpoint}`, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${store.tokens.access_token}`,
            'Content-Type': 'application/json',
            ...(notionVersion ? { 'Notion-Version': notionVersion } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const payload = await response.json().catch(() => ({}));

        if (response.ok) {
          return payload;
        }

        const error = createNotionError(response, payload);

        if (!shouldRetryError(error) || attempt >= maxRetries) {
          throw error;
        }

        await sleep(retryDelayMs(error, attempt, { baseBackoffMs, maxBackoffMs }));
      } catch (error) {
        if (isNotionError(error) || attempt >= maxRetries) {
          throw error;
        }

        await sleep(backoffDelayMs(attempt, { baseBackoffMs, maxBackoffMs }));
      }

      attempt += 1;
    }
  };
}

export function createRateLimiter({
  requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const intervalMs = 1_000 / requestsPerSecond;
  let nextAvailableAt = 0;

  return {
    async waitForTurn() {
      const currentTime = now();
      const waitMs = Math.max(0, nextAvailableAt - currentTime);
      nextAvailableAt = Math.max(currentTime, nextAvailableAt) + intervalMs;

      if (waitMs > 0) {
        await sleep(waitMs);
      }
    },
  };
}

function createNotionError(response, payload) {
  const error = new Error(payload.message ?? `Notion returned ${response.status}.`);
  error.status = response.status;
  error.code = payload.code;
  error.retryAfter = retryAfterHeader(response);
  error.isNotionApiError = true;
  return error;
}

function retryAfterHeader(response) {
  const value = response.headers?.get?.('Retry-After');
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function shouldRetryError(error) {
  if (error.status === 429 && error.code === 'rate_limited') {
    return true;
  }

  return [500, 502, 503, 504].includes(error.status);
}

function retryDelayMs(error, attempt, options) {
  if (error.status === 429 && error.retryAfter !== undefined) {
    return error.retryAfter * 1_000;
  }

  return backoffDelayMs(attempt, options);
}

function backoffDelayMs(attempt, { baseBackoffMs, maxBackoffMs }) {
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt);
}

function isNotionError(error) {
  return Boolean(error?.isNotionApiError);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
