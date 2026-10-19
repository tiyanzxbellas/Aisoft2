// Satu-satunya pintu keluar request ke upstream.
// server.js / api/index.js tidak boleh fetch sendiri — semua lewat proxyFetch / proxyStream.
// Host animein kena Cloudflare JS challenge dari IP datacenter, jadi path utama
// adalah CORS worker (CF_PROXY) + header browser di bawah.
import { request, Agent, setGlobalDispatcher, interceptors } from 'undici';
import tls from 'tls';

const UA_POOL = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    pf: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    pf: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    pf: '"Linux"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ch: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    pf: '"Windows"'
  }
];

const DEFAULT_CF_PROXY = 'https://cf.tiyanstores.workers.dev/';
const DEFAULT_PROXY_SECRET = 'animein-secure-proxy-key-123';
const CF_PROTECTED_HOSTS = /(^|\.)animein\.net$|(^|\.)animeinweb\.com$/i;

function getCfProxy() {
  return (process.env.CF_PROXY || DEFAULT_CF_PROXY).replace(/\/?$/, '/');
}

function getProxySecret() {
  return process.env.PROXY_SECRET || DEFAULT_PROXY_SECRET;
}

const defaultCiphers = tls.DEFAULT_CIPHERS.split(':');
const shuffledCiphers = [
  defaultCiphers[1],
  defaultCiphers[2],
  defaultCiphers[0],
  ...defaultCiphers.slice(3)
].join(':');

const agent = new Agent({
  allowH2: true,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connect: {
    ciphers: shuffledCiphers,
    rejectUnauthorized: true
  }
}).compose(
  interceptors.redirect({ maxRedirections: 5 }),
  interceptors.retry({ maxRetries: 2 })
);

setGlobalDispatcher(agent);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

export function viaWorker(targetUrl) {
  return `${getCfProxy()}?url=${encodeURIComponent(targetUrl)}`;
}

export function isProtectedHost(targetUrl) {
  try {
    return CF_PROTECTED_HOSTS.test(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}

export function isCloudflareChallenge(statusCode, text = '') {
  if (![403, 429, 503].includes(Number(statusCode))) return false;
  return /just a moment|cf-chl|challenge-platform|cdn-cgi\/challenge|enable javascript and cookies|_cf_chl_opt/i.test(String(text));
}

function browserHeaders(targetUrl, extra = {}) {
  const ua = pickUA();
  const urlObj = new URL(targetUrl);
  const originUrl = `${urlObj.protocol}//${urlObj.host}`;
  return {
    'User-Agent': ua.ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': originUrl,
    'Referer': `${originUrl}/`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Proxy-Secret': extra.secret || getProxySecret(),
    'Sec-Ch-Ua': ua.ch,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': ua.pf,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    ...extra.headers
  };
}

function buildAttempts(targetUrl, opts = {}) {
  const attempts = [];
  const workerFirst = opts.forceWorker || isProtectedHost(targetUrl);

  if (workerFirst) {
    attempts.push({ kind: 'worker', url: viaWorker(targetUrl) });
    if (!opts.workerOnly) attempts.push({ kind: 'direct', url: targetUrl });
  } else {
    attempts.push({ kind: 'direct', url: targetUrl });
    attempts.push({ kind: 'worker', url: viaWorker(targetUrl) });
  }

  return attempts;
}

function summarizeError(statusCode, text) {
  if (isCloudflareChallenge(statusCode, text)) {
    return `Cloudflare challenge (Just a moment...) [status ${statusCode}]`;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.message) return `${parsed.message} (status ${statusCode})`;
  } catch { /* ignore */ }
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
  return snippet ? `Target returned status ${statusCode}: ${snippet}` : `Target returned status ${statusCode}`;
}

async function requestText(url, headers, timeouts = {}) {
  const { statusCode, headers: resHeaders, body } = await request(url, {
    method: 'GET',
    headers,
    headersTimeout: timeouts.headersTimeout ?? 10000,
    bodyTimeout: timeouts.bodyTimeout ?? 20000
  });
  const text = await body.text();
  return { statusCode, resHeaders, text };
}

export async function proxyFetch(targetUrl, opts = {}) {
  const attempts = buildAttempts(targetUrl, opts);
  let lastErr = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const headers = browserHeaders(targetUrl, {
      secret: opts.secret,
      headers: opts.headers
    });

    if (attempt.kind === 'direct') {
      headers.Host = new URL(targetUrl).host;
    }

    try {
      const { statusCode, resHeaders, text } = await requestText(attempt.url, headers);

      if (statusCode === 200) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }

      const err = new Error(summarizeError(statusCode, text));
      err.statusCode = statusCode;
      err.via = attempt.kind;
      err.headers = resHeaders;
      try {
        err.body = JSON.parse(text);
      } catch {
        err.body = String(text || '').slice(0, 400);
      }

      lastErr = err;

      const retryable = isCloudflareChallenge(statusCode, text) || statusCode === 403 || statusCode >= 500;
      if (retryable && i < attempts.length - 1) {
        await sleep(200 + i * 300);
        continue;
      }
      throw err;
    } catch (err) {
      if (!err.statusCode) {
        lastErr = new Error(`${attempt.kind} fetch failed: ${err.message}`);
        lastErr.via = attempt.kind;
        if (i < attempts.length - 1) {
          await sleep(250 + i * 350);
          continue;
        }
        throw lastErr;
      }
      lastErr = err;
      if (i < attempts.length - 1) {
        await sleep(200 + i * 300);
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('Target fetch failed on all paths');
}

export async function fetchJson(url, options = {}) {
  const ua = pickUA();
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: {
          'User-Agent': ua.ua,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          ...options.headers
        },
        headersTimeout: 5000,
        bodyTimeout: 8000
      });
      const txt = await body.text();
      if (statusCode !== 200) {
        throw new Error(`Jikan returned ${statusCode}: ${txt.slice(0, 200)}`);
      }
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      if (i < 1) await sleep(300 + i * 400);
    }
  }
  throw lastErr;
}

export async function proxyStream(targetUrl, incomingHeaders = {}) {
  const attempts = buildAttempts(targetUrl);
  let lastErr = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const ua = pickUA();
    const urlObj = new URL(targetUrl);

    const headersToSend = {
      'User-Agent': ua.ua,
      'Accept': incomingHeaders.accept || incomingHeaders['accept'] || '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://animeinweb.com',
      'Referer': 'https://animeinweb.com/',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Proxy-Secret': getProxySecret(),
      'Sec-Ch-Ua': ua.ch,
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': ua.pf,
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Connection': 'keep-alive'
    };

    if (attempt.kind === 'direct') {
      headersToSend.Host = urlObj.host;
    }
    if (incomingHeaders.range || incomingHeaders.Range) {
      headersToSend.Range = incomingHeaders.range || incomingHeaders.Range;
    }

    try {
      const { statusCode, headers, body } = await request(attempt.url, {
        method: 'GET',
        headers: headersToSend
      });

      if ([403, 429, 503].includes(Number(statusCode)) && i < attempts.length - 1) {
        try { body.dump(); } catch { /* ignore */ }
        lastErr = new Error(`Blocked status ${statusCode} on ${attempt.kind} stream`);
        lastErr.statusCode = statusCode;
        continue;
      }

      return { statusCode, headers, body, via: attempt.kind };
    } catch (err) {
      lastErr = err;
      if (i < attempts.length - 1) {
        await sleep(200);
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('Stream failed on all paths');
}

export async function testSecrets(targetUrl, secrets) {
  const results = [];
  for (const sec of secrets) {
    try {
      const data = await proxyFetch(targetUrl, { secret: sec });
      results.push({ secret: sec, success: true, status: 200, sample: JSON.stringify(data).slice(0, 200) });
    } catch (e) {
      results.push({ secret: sec, success: false, status: e.statusCode || 0, via: e.via, message: e.message, body: e.body });
    }
  }
  return results;
}

export function getProxyConfig() {
  return {
    cf_proxy: getCfProxy(),
    proxy_secret_set: Boolean(process.env.PROXY_SECRET)
  };
}
