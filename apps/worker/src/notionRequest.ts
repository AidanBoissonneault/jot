/**
 * @file Sends authenticated Notion API requests with rate limiting, retries, and file uploads.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type {
  JsonObject,
  NotionObject,
  NotionRequester,
  PartialNotionRequestInit,
  WorkerStore,
} from './types.js';

const DEFAULT_REQUESTS_PER_SECOND = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 2_000;

/** Describes the requester options contract used by this API feature. */
interface RequesterOptions {
  baseBackoffMs: number;
  baseUrl: string;
  fetchImpl: typeof fetch;
  maxBackoffMs: number;
  maxRetries: number;
  notionVersion: string | undefined;
  now: () => number;
  requestsPerSecond: number;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Describes the file upload contract used by this API feature. */
interface FileUpload {
  data: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
}

/** Describes the file upload options contract used by this API feature. */
interface FileUploadOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  notionVersion: string | undefined;
}

/** Describes the rate limiter options contract used by this API feature. */
interface RateLimiterOptions {
  now: () => number;
  requestsPerSecond: number;
  sleep: (milliseconds: number) => Promise<void>;
}

/** Describes the backoff options contract used by this API feature. */
interface BackoffOptions {
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/** Describes the notion api error contract used by this API feature. */
class NotionApiError extends Error {
  readonly code: string | undefined;
  readonly isNotionApiError = true;
  readonly retryAfter: number | undefined;
  readonly status: number;

  /**
   * Defines a typed error returned by the Notion HTTP API.
   * @param message - Human-readable API failure details.
   * @param status - HTTP response status.
   * @param code - Notion's machine-readable error code.
   * @param retryAfter - Server-requested retry delay in seconds.
   */
  constructor(message: string, status: number, code: string | undefined, retryAfter: number | undefined) {
    super(message);
    this.name = 'NotionApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Creates a rate-limited Notion request function with bounded retry behavior.
 * @param options - Optional transport, version, rate, and retry overrides.
 * @returns A requester bound to the supplied transport policy.
 */
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
}: Partial<RequesterOptions> = {}): NotionRequester {
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required for Notion requests.');
  }

  const apiBase = parseNotionApiBase(baseUrl);

  const limiter = createRateLimiter({
    requestsPerSecond,
    sleep,
    now,
  });

  /**
   * Sends one authenticated request to a Notion endpoint.
   * @param store - Connected worker state containing the Notion access token.
   * @param endpoint - API path relative to the configured Notion base URL.
   * @param init - Optional HTTP method, headers, and JSON body.
   * @returns The parsed Notion response object.
   */
  return async function notionRequest(
    store: WorkerStore,
    endpoint: string,
    init: PartialNotionRequestInit = {},
  ): Promise<NotionObject> {
    if (!store.tokens) {
      throw new Error('A connected Notion token is required.');
    }

    const requestUrl = notionApiUrl(apiBase, endpoint);

    const method = (init.method ?? 'GET').toUpperCase();
    const canRetryAmbiguousFailure = isSafeToRetry(method, endpoint);
    let attempt = 0;

    while (true) {
      await limiter.waitForTurn();

      try {
        const response = await fetchImpl(requestUrl, {
          redirect: 'error',
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${store.tokens.access_token}`,
            'Content-Type': 'application/json',
            ...(notionVersion ? { 'Notion-Version': notionVersion } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const payload: unknown = await response.json().catch(() => ({}));

        if (response.ok) {
          return notionObject(payload);
        }

        const error = createNotionError(response, payload);

        const rateLimited = error.status === 429 && error.code === 'rate_limited';
        if (
          !shouldRetryError(error) ||
          attempt >= maxRetries ||
          (!rateLimited && !canRetryAmbiguousFailure)
        ) {
          throw error;
        }

        await sleep(retryDelayMs(error, attempt, { baseBackoffMs, maxBackoffMs }));
      } catch (error) {
        if (isNotionError(error) || attempt >= maxRetries || !canRetryAmbiguousFailure) {
          throw error;
        }

        await sleep(backoffDelayMs(attempt, { baseBackoffMs, maxBackoffMs }));
      }

      attempt += 1;
    }
  };
}

/**
 * Avoids replaying writes whose outcome may be unknown after a timeout or 5xx.
 * Creating children is a PATCH in Notion's API, so it is excluded even though
 * ordinary resource PATCH requests are safe to repeat.
 */
function isSafeToRetry(method: string, endpoint: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return true;
  if (method !== 'PATCH') return false;
  return !/^\/blocks\/[^/]+\/children(?:\?|$)/.test(endpoint);
}

/**
 * Uploads one binary file through Notion's single-part upload flow.
 * @param store - Connected worker state containing the Notion access token.
 * @param upload - File bytes and metadata to upload.
 * @param options - Optional Notion transport configuration.
 * @returns The Notion file-upload identifier.
 */
export async function uploadFileToNotion(
  store: WorkerStore,
  { data, mimeType, filename }: FileUpload,
  {
    notionVersion,
    baseUrl = 'https://api.notion.com/v1',
    fetchImpl = globalThis.fetch,
  }: Partial<FileUploadOptions> = {},
): Promise<string> {
  if (!store.tokens) {
    throw new Error('A connected Notion token is required.');
  }

  const apiBase = parseNotionApiBase(baseUrl);

  const sessionRes = await fetchImpl(notionApiUrl(apiBase, '/file_uploads'), {
    redirect: 'error',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.tokens.access_token}`,
      'Content-Type': 'application/json',
      ...(notionVersion ? { 'Notion-Version': notionVersion } : {}),
    },
    body: JSON.stringify({
      mode: 'single_part',
      filename,
      content_type: mimeType,
    }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text().catch(() => '');
    throw new Error(`Notion file upload session failed: ${sessionRes.status} ${text}`);
  }
  const sessionPayload: unknown = await sessionRes.json();
  const id = stringProperty(sessionPayload, 'id');

  if (!id) {
    throw new Error('Notion file upload session did not return an id.');
  }

  const body = new FormData();
  body.append('file', new Blob([data], { type: mimeType }), filename);

  const uploadRes = await fetchImpl(notionApiUrl(apiBase, `/file_uploads/${id}/send`), {
    redirect: 'error',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.tokens.access_token}`,
      ...(notionVersion ? { 'Notion-Version': notionVersion } : {}),
    },
    body,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`Notion file upload failed: ${uploadRes.status} ${text}`);
  }

  const upload: unknown = await uploadRes.json().catch(() => ({}));
  const status = stringProperty(upload, 'status');

  if (status !== 'uploaded') {
    throw new Error(`Notion file upload did not finish. Status: ${status ?? 'unknown'}.`);
  }

  return id;
}

interface NotionApiBase {
  origin: string;
  pathname: string;
}

/** Validates the configured API base once before attaching any bearer token. */
function parseNotionApiBase(baseUrl: string): NotionApiBase {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('The Notion API base URL is invalid.');
  }
  if (
    url.origin !== 'https://api.notion.com' ||
    url.pathname.replace(/\/$/, '') !== '/v1' ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  ) {
    throw new Error('The Notion API base URL must be https://api.notion.com/v1.');
  }
  return { origin: url.origin, pathname: url.pathname.replace(/\/$/, '') };
}

/** Keeps every authenticated request inside the configured API path. */
function notionApiUrl(base: NotionApiBase, endpoint: string): string {
  if (
    !endpoint.startsWith('/') ||
    endpoint.startsWith('//') ||
    endpoint.includes('\\') ||
    endpoint.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(endpoint)
  ) {
    throw new Error('The Notion API endpoint is invalid.');
  }

  const [path, ...queryParts] = endpoint.split('?');
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error('The Notion API endpoint contains an invalid path segment.');
  }
  const isResource = /^\/(?:pages|blocks|databases|data_sources|views)\/[A-Za-z0-9_-]+$/.test(path);
  const isBlockChildren = /^\/blocks\/[A-Za-z0-9_-]+\/children$/.test(path);
  const isDataSourceQuery = /^\/data_sources\/[A-Za-z0-9_-]+\/query$/.test(path);
  const validPath = new Set([
    '/search', '/pages', '/blocks', '/databases', '/data_sources', '/views', '/file_uploads',
  ]).has(path) || isResource || isBlockChildren || isDataSourceQuery ||
    /^\/file_uploads\/[A-Za-z0-9_-]+\/send$/.test(path);
  const queryAllowed = path === '/views' || isBlockChildren;
  if (!validPath || (queryParts.length > 0 && !queryAllowed)) {
    throw new Error('The Notion API endpoint is not a supported API route.');
  }
  const query = queryParts.length ? `?${queryParts.join('?')}` : '';
  const url = new URL(`${base.pathname}${path}${query}`, base.origin);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
    throw new Error('The Notion API endpoint escapes the configured API path.');
  }
  return url.toString();
}

/**
 * Creates a serial request limiter based on a minimum request interval.
 * @param options - Clock, sleep function, and maximum request rate.
 * @returns An object that waits until the next request slot is available.
 */
function createRateLimiter({
  requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND,
  sleep = defaultSleep,
  now = Date.now,
}: Partial<RateLimiterOptions> = {}): { waitForTurn: () => Promise<void> } {
  const intervalMs = 1_000 / requestsPerSecond;
  let nextAvailableAt = 0;

  return {
    /**
     * Waits for and reserves the next request slot.
     * @returns A promise resolved when the caller may issue a request.
     */
    async waitForTurn(): Promise<void> {
      const currentTime = now();
      const waitMs = Math.max(0, nextAvailableAt - currentTime);
      nextAvailableAt = Math.max(currentTime, nextAvailableAt) + intervalMs;

      if (waitMs > 0) {
        await sleep(waitMs);
      }
    },
  };
}

/**
 * Converts an unsuccessful HTTP response into a typed Notion API error.
 * @param response - Failed HTTP response.
 * @param payload - Untrusted JSON response body.
 * @returns A normalized Notion API error.
 */
function createNotionError(response: Response, payload: unknown): NotionApiError {
  return new NotionApiError(
    stringProperty(payload, 'message') ?? `Notion returned ${response.status}.`,
    response.status,
    stringProperty(payload, 'code'),
    retryAfterHeader(response),
  );
}

/**
 * Reads a valid retry delay from an HTTP response.
 * @param response - Notion HTTP response.
 * @returns Retry delay in seconds, or undefined when absent or invalid.
 */
function retryAfterHeader(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Determines whether a Notion API error is transient.
 * @param error - Typed Notion API failure.
 * @returns Whether retrying the request is appropriate.
 */
function shouldRetryError(error: NotionApiError): boolean {
  if (error.status === 429 && error.code === 'rate_limited') {
    return true;
  }

  return [500, 502, 503, 504].includes(error.status);
}

/**
 * Computes the next retry delay, honoring Notion's Retry-After header.
 * @param error - Typed Notion API failure.
 * @param attempt - Zero-based retry attempt number.
 * @param options - Exponential backoff bounds.
 * @returns Delay in milliseconds.
 */
function retryDelayMs(error: NotionApiError, attempt: number, options: BackoffOptions): number {
  if (error.status === 429 && error.retryAfter !== undefined) {
    return error.retryAfter * 1_000;
  }

  return backoffDelayMs(attempt, options);
}

/**
 * Computes a capped exponential backoff delay.
 * @param attempt - Zero-based retry attempt number.
 * @param options - Base and maximum delays.
 * @returns Delay in milliseconds.
 */
function backoffDelayMs(
  attempt: number,
  { baseBackoffMs, maxBackoffMs }: BackoffOptions,
): number {
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt);
}

/**
 * Narrows an unknown thrown value to a Notion API error.
 * @param error - Unknown thrown value.
 * @returns Whether the value is a Notion API error.
 */
function isNotionError(error: unknown): error is NotionApiError {
  return error instanceof NotionApiError;
}

/**
 * Resolves after the requested delay.
 * @param milliseconds - Delay duration in milliseconds.
 * @returns A promise resolved after the timer fires.
 */
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void) => setTimeout(resolve, milliseconds));
}

/**
 * Validates a parsed successful response as an object at the HTTP boundary.
 * @param value - Untrusted parsed JSON.
 * @returns The response narrowed to the shared Notion object contract.
 */
function notionObject(value: unknown): NotionObject {
  if (!isJsonObject(value)) {
    throw new Error('Notion returned a non-object JSON response.');
  }

  return value as NotionObject;
}

/**
 * Reads a string property from an untrusted object.
 * @param value - Value that may contain the property.
 * @param key - Property name to read.
 * @returns The string value, or undefined when it is absent or invalid.
 */
function stringProperty(value: unknown, key: string): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const property: unknown = value[key];
  return typeof property === 'string' ? property : undefined;
}

/**
 * Determines whether a value is a non-null JSON object.
 * @param value - Unknown value to inspect.
 * @returns Whether the value can be safely indexed as an object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
