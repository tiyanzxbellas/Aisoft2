/**
 * Cloudflare Worker untuk meneruskan request ke API Animein.
 *
 * Set secret PROXY_SECRET di Worker Settings > Variables and Secrets.
 * Nilainya harus sama dengan PROXY_SECRET di Vercel. Jangan menaruh secret
 * di source code atau mengandalkannya dari browser.
 *
 * Penting: Worker/CORS tidak dapat menyelesaikan Cloudflare JS challenge pada
 * origin. Origin harus mengizinkan route API ini (bypass/skip managed
 * challenge untuk /3/2/*), atau proxy ini tetap akan menerima 403.
 */
const ALLOWED_HOSTS = new Set([
  'xyz-api.animein.net',
  'animein.net',
  'www.animein.net',
  'animeinweb.com',
  'www.animeinweb.com',
  'storages.animein.net'
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, X-Proxy-Secret',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};

function response(body, init = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return response(null, { status: 204 });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return response('Method not allowed', { status: 405 });
    }

    const incoming = new URL(request.url);
    const rawTarget = incoming.searchParams.get('url');
    if (!rawTarget) return response('Missing ?url=', { status: 400 });

    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return response('Invalid target URL', { status: 400 });
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
      return response('Target host is not allowed', { status: 403 });
    }

    const headers = new Headers();
    headers.set('Accept', request.headers.get('Accept') || '*/*');
    headers.set('Accept-Language', request.headers.get('Accept-Language') || 'id-ID,id;q=0.9,en-US;q=0.8');
    headers.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
    headers.set('Referer', 'https://animeinweb.com/');
    headers.set('X-Requested-With', 'XMLHttpRequest');
    if (env.PROXY_SECRET) headers.set('X-Proxy-Secret', env.PROXY_SECRET);
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    } catch (error) {
      return response(`Upstream request failed: ${error.message}`, { status: 502 });
    }

    const out = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) out.set(key, value);
    // Do not expose hop-by-hop headers from the origin.
    out.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
