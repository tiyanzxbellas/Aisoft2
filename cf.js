// Direct JSON client for the Jikan API. Requests are sent to their target URL
// without a worker, proxy, browser-origin headers, or proxy credentials.
import { request } from 'undici';

const MAX_REQUESTS_PER_SECOND = 3;
const MAX_REQUESTS_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND);
const MAX_RETRIES = 2;

const requestStartTimes = [];
let lastRequestStartedAt = 0;
let rateLimitQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Serialize request starts so concurrent routes respect Jikan's published
// per-second and per-minute limits within this Node process.
function acquireRequestSlot() {
  const slot = rateLimitQueue.then(async () => {
    while (true) {
      const now = Date.now();
      while (requestStartTimes.length && now - requestStartTimes[0] >= RATE_WINDOW_MS) {
        requestStartTimes.shift();
      }

      const perSecondDelay = Math.max(0, lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - now);
      const perMinuteDelay = requestStartTimes.length >= MAX_REQUESTS_PER_MINUTE
        ? Math.max(0, requestStartTimes[0] + RATE_WINDOW_MS - now)
        : 0;
      const waitMs = Math.max(perSecondDelay, perMinuteDelay);

      if (waitMs === 0) {
        const startedAt = Date.now();
        requestStartTimes.push(startedAt);
        lastRequestStartedAt = startedAt;
        return;
      }

      await sleep(waitMs);
    }
  });

  rateLimitQueue = slot.catch(() => {});
  return slot;
}

function retryDelay(headers, attempt, statusCode) {
  const retryAfter = headers?.['retry-after'];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(60_000, seconds * 1000));

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, Math.min(60_000, retryAt - Date.now()));
  }

  return statusCode === 429 ? 1000 : Math.min(4000, 500 * (2 ** attempt));
}

function httpError(statusCode, text) {
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
  const error = new Error(`Jikan returned ${statusCode}${snippet ? `: ${snippet}` : ''}`);
  error.statusCode = statusCode;
  return error;
}

/** Fetch and parse a JSON response directly from an HTTPS API URL. */
export async function fetchJson(targetUrl, options = {}) {
  const url = new URL(targetUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Upstream API URLs must use HTTPS');
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await acquireRequestSlot();

    try {
      const { statusCode, headers, body } = await request(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'Aisoft2 Jikan API client',
          ...options.headers
        },
        headersTimeout: 10_000,
        bodyTimeout: 20_000
      });
      const text = await body.text();

      if (statusCode < 200 || statusCode >= 300) {
        const error = httpError(statusCode, text);
        lastError = error;
        const retryable = statusCode === 429 || statusCode >= 500;
        if (!retryable || attempt === MAX_RETRIES) throw error;
        await sleep(retryDelay(headers, attempt, statusCode));
        continue;
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Jikan returned an invalid JSON response');
      }
    } catch (error) {
      lastError = error;
      const statusCode = Number(error.statusCode);
      const retryable = !statusCode || statusCode === 429 || statusCode >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw error;

      // HTTP errors have already waited according to Retry-After above.
      if (!statusCode) await sleep(Math.min(4000, 500 * (2 ** attempt)));
    }
  }

  throw lastError || new Error('Jikan request failed');
}
