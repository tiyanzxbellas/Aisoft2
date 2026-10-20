// cf.js — satu-satunya pintu keluar request.
//
// Temuan lapangan (2026-10-20):
//   * xyz-api.animein.net memfilter berdasarkan FINGERPRINT TLS/HTTP2, bukan header.
//     curl (OpenSSL/HTTP2 milik curl) -> 200. Node undici / node:https / fetch -> 403
//     "Just a moment..." walau header 100% sama.
//   * Karena itu transport utama = binary `curl`. Kalau curl tidak ada (mis. runtime
//     tertentu), otomatis jatuh ke undici.
//   * Endpoint API: cukup User-Agent browser.
//   * Asset gambar (/assets*/...): WAJIB Referer https://animeinweb.com/
//   * File video storages.animein.net: cukup User-Agent, mendukung Range (206).
import { request, Agent } from 'undici';
import { execFile, spawn } from 'node:child_process';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
];

export const DEFAULT_BASE_API = 'https://xyz-api.animein.net/3/2';

export function baseApi() {
  return (process.env.BASE_API || DEFAULT_BASE_API).replace(/\/+$/, '');
}

export function refererSite() {
  return process.env.REFERER_SITE || 'https://animeinweb.com/';
}

const STATUS_MARK = '\n__HTTP_STATUS__:';

const agent = new Agent({ keepAliveTimeout: 25000, connect: { rejectUnauthorized: true } });

function pickUA(seed) {
  if (Number.isInteger(seed)) return UAS[seed % UAS.length];
  return UAS[Math.floor(Math.random() * UAS.length)];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function isAnimeinHost(url) {
  const h = hostOf(url);
  return h === 'animein.net' || h.endsWith('.animein.net') || h === 'animeinweb.com' || h.endsWith('.animeinweb.com');
}

export function isAllowedProxyTarget(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return isAnimeinHost(url);
  } catch { return false; }
}

function kindOf(url) {
  const h = hostOf(url);
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (h.startsWith('storages.') || h.startsWith('cdn.')) return 'media';
  if (path.includes('/assets')) return 'asset';
  return 'api';
}

function headersFor(url, ua, extra = {}) {
  const kind = kindOf(url);
  const h = {
    'User-Agent': ua,
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
  };
  if (kind === 'api') {
    h.Accept = 'application/json, text/plain, */*';
  } else {
    h.Referer = refererSite();
    h.Origin = new URL(refererSite()).origin;
    h.Accept = kind === 'asset'
      ? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      : '*/*';
  }
  return { ...h, ...extra };
}

// ---------------------------------------------------------------- transport
let transportPromise = null;

function curlVersion() {
  return new Promise(resolve => {
    execFile('curl', ['--version'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout || '').split('\n')[0].trim();
      return resolve(first || 'curl');
    });
  });
}

export async function transportInfo() {
  if (!transportPromise) {
    transportPromise = (async () => {
      const forced = String(process.env.USE_CURL ?? '').toLowerCase();
      if (forced === '0' || forced === 'false' || forced === 'off') {
        return { kind: 'undici', version: null, reason: 'USE_CURL=0' };
      }
      const v = await curlVersion();
      if (v) return { kind: 'curl', version: v, reason: 'auto' };
      return { kind: 'undici', version: null, reason: 'curl tidak tersedia' };
    })();
  }
  return transportPromise;
}

export async function transportName() {
  return (await transportInfo()).kind;
}

function execCurl(args, timeoutMs, encoding = 'utf8', maxBuffer = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout: timeoutMs + 3000, maxBuffer, encoding }, (err, stdout, stderr) => {
      if (err && (!stdout || stdout.length === 0)) {
        const msg = String(stderr || err.message || '').trim().split('\n')[0];
        return reject(new Error(`curl gagal: ${msg || 'unknown error'}`));
      }
      resolve(stdout);
    });
  });
}

function curlArgsFor(url, { ua, extraHeaders, timeoutMs, withStatus = true, noCompress = false }) {
  const headers = headersFor(url, ua, extraHeaders);
  const args = ['-sS', '-m', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
  if (!noCompress) args.push('--compressed');
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null || v === '') continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (withStatus) args.push('-w', STATUS_MARK + '%{http_code}');
  args.push('--url', url);
  return args;
}

function splitStatus(text) {
  const i = text.lastIndexOf(STATUS_MARK);
  if (i < 0) return { status: 0, body: text };
  const status = Number(text.slice(i + STATUS_MARK.length).trim()) || 0;
  return { status, body: text.slice(0, i) };
}

function splitStatusBuffer(buf) {
  const mark = Buffer.from(STATUS_MARK);
  const i = buf.lastIndexOf(mark);
  if (i < 0) return { status: 0, body: buf };
  const status = Number(buf.slice(i + mark.length).toString('utf8').trim()) || 0;
  return { status, body: buf.slice(0, i) };
}

export class HttpError extends Error {
  constructor(message, { status = 0, via = 'unknown', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = status;
    this.via = via;
    this.body = String(body || '').slice(0, 400);
  }
}

export function isCloudflareChallenge(status, text = '') {
  if (![403, 429, 503].includes(Number(status))) return false;
  return /just a moment|cf-chl|challenge-platform|cdn-cgi\/challenge|attention required|enable javascript and cookies|_cf_chl_opt/i.test(String(text));
}

function describe(status, text) {
  if (isCloudflareChallenge(status, text)) {
    return `Cloudflare challenge [${status}] — transport tidak lolos fingerprint`;
  }
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
  return snippet ? `Upstream ${status}: ${snippet}` : `Upstream ${status}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);

// ------------------------------------------------------------- public API
export async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeout ?? Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
  const attempts = opts.attempts ?? 2;
  const t = await transportInfo();
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const ua = pickUA(opts.uaSeed ?? (attempts > 1 ? i : undefined));
    try {
      let status;
      let body;
      let via = t.kind;

      if (t.kind === 'curl') {
        const out = await execCurl(curlArgsFor(url, { ua, extraHeaders: opts.headers, timeoutMs }), timeoutMs);
        ({ status, body } = splitStatus(String(out)));
      } else {
        const r = await request(url, {
          method: 'GET',
          headers: headersFor(url, ua, opts.headers),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          dispatcher: agent
        });
        status = r.statusCode;
        body = await r.body.text();
      }

      if (status >= 200 && status < 300) return { status, text: body, via };

      lastErr = new HttpError(describe(status, body), { status, via, body });
      if (i < attempts - 1 && RETRY_STATUS.has(status)) {
        await sleep(250 + i * 400);
        continue;
      }
      throw lastErr;
    } catch (e) {
      if (e instanceof HttpError) {
        if (i < attempts - 1 && RETRY_STATUS.has(e.statusCode)) { await sleep(250 + i * 400); continue; }
        throw e;
      }
      lastErr = new HttpError(`Request gagal: ${e.message}`, { via: t.kind });
      if (i < attempts - 1) { await sleep(300); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new HttpError('Request gagal');
}

export async function fetchJson(url, opts = {}) {
  const { status, text, via } = await fetchText(url, opts);
  if (!text || !text.trim()) {
    throw new HttpError('Upstream mengembalikan body kosong', { status, via, body: text });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('Upstream bukan JSON', { status, via, body: text });
  }
}

export async function fetchBuffer(url, opts = {}) {
  const timeoutMs = opts.timeout ?? Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
  const t = await transportInfo();
  const ua = pickUA(opts.uaSeed);

  if (t.kind === 'curl') {
    const out = await execCurl(
      curlArgsFor(url, { ua, extraHeaders: opts.headers, timeoutMs, noCompress: true }),
      timeoutMs,
      'buffer',
      Number(opts.maxBytes || 32 * 1024 * 1024)
    );
    const { status, body } = splitStatusBuffer(out);
    return { status, buffer: body, via: t.kind };
  }

  const r = await request(url, {
    method: 'GET',
    headers: headersFor(url, ua, opts.headers),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    dispatcher: agent
  });
  const chunks = [];
  for await (const c of r.body) chunks.push(c);
  return { status: r.statusCode, buffer: Buffer.concat(chunks), via: t.kind };
}

function parseHeaders(block) {
  const out = {};
  for (const line of String(block).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

// Ambil status + header tanpa mengunduh body besar.
export async function probe(url, opts = {}) {
  const timeoutMs = opts.timeout ?? 12000;
  const t = await transportInfo();
  const ua = pickUA(opts.uaSeed);

  if (t.kind === 'curl') {
    const args = ['-sS', '-m', String(Math.ceil(timeoutMs / 1000)), '-I', '--url', url];
    for (const [k, v] of Object.entries(headersFor(url, ua, opts.headers))) {
      if (v) args.push('-H', `${k}: ${v}`);
    }
    args.push('-D', '-', '-o', '/dev/null');

    const raw = await execCurl(args, timeoutMs).catch(() => '');
    const blocks = String(raw).split(/\r?\n\r?\n/).filter(Boolean);
    const last = blocks[blocks.length - 1] || '';
    const statusLine = last.split(/\r?\n/)[0] || '';
    const status = Number((statusLine.match(/HTTP\/[\d.]+\s+(\d{3})/) || [])[1] || 0);
    if (status) return { status, headers: parseHeaders(last), via: 'curl' };

    // HEAD tidak didukung -> sniff pakai range 1 byte
    const probeArgs = ['-sS', '-m', String(Math.ceil(timeoutMs / 1000)), '-r', '0-0', '-D', '-', '-o', '/dev/null', '--url', url];
    for (const [k, v] of Object.entries(headersFor(url, ua, opts.headers))) {
      if (v) probeArgs.push('-H', `${k}: ${v}`);
    }
    const raw2 = await execCurl(probeArgs, timeoutMs).catch(() => '');
    const blocks2 = String(raw2).split(/\r?\n\r?\n/).filter(Boolean);
    const last2 = blocks2[blocks2.length - 1] || '';
    const s2 = Number(((last2.split(/\r?\n/)[0] || '').match(/HTTP\/[\d.]+\s+(\d{3})/) || [])[1] || 0);
    return { status: s2, headers: parseHeaders(last2), via: 'curl' };
  }

  const r = await request(url, {
    method: 'HEAD',
    headers: headersFor(url, ua, opts.headers),
    headersTimeout: timeoutMs,
    dispatcher: agent
  });
  try { r.body.dump(); } catch { /* ignore */ }
  return { status: r.statusCode, headers: r.headers, via: 'undici' };
}

// Stream body ke Express response (dipakai /v1/proxy).
export async function pipeTo(url, res, opts = {}) {
  const range = opts.range || null;
  // HEAD ikut membawa Range supaya dapat 206 + Content-Range/Content-Length yang benar.
  const info = await probe(url, { uaSeed: opts.uaSeed, headers: range ? { Range: range } : {} }).catch(() => null);

  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  if (info?.status && [200, 206].includes(info.status)) {
    res.status(info.status);
    for (const k of passthrough) {
      if (info.headers[k]) res.setHeader(k, info.headers[k]);
    }
  } else {
    res.status(200);
  }
  if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('cache-control', 'public, max-age=3600');

  const t = await transportInfo();
  const ua = pickUA(opts.uaSeed);
  const timeoutMs = opts.timeout ?? Number(process.env.STREAM_TIMEOUT_MS || 600000);

  if (t.kind === 'curl') {
    const args = ['-sS', '-m', String(Math.ceil(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headersFor(url, ua, opts.headers))) {
      if (v && k.toLowerCase() !== 'accept-encoding') args.push('-H', `${k}: ${v}`);
    }
    if (range) args.push('-H', `Range: ${range}`);
    args.push('--url', url);

    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res);
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
    res.on('close', kill);
    child.on('error', () => { try { res.end(); } catch { /* ignore */ } });
    child.on('close', () => { try { res.end(); } catch { /* ignore */ } });
    return { via: 'curl', upstream: info?.status || 0 };
  }

  const headers = headersFor(url, ua, opts.headers);
  if (range) headers.Range = range;
  const r = await request(url, { method: 'GET', headers, dispatcher: agent, bodyTimeout: timeoutMs });
  res.status(r.statusCode);
  try { await r.body.pipe(res); } catch { /* ignore */ }
  return { via: 'undici', upstream: r.statusCode };
}

export function proxyConfig() {
  return {
    base_api: baseApi(),
    referer: refererSite(),
    use_curl: String(process.env.USE_CURL ?? 'auto'),
    upstream_timeout_ms: Number(process.env.UPSTREAM_TIMEOUT_MS || 15000)
  };
}
