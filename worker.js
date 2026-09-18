/**
 * Cloudflare Worker — CORS proxy ke API Animein.
 *
 * CARA KERJA PENTING:
 * Worker ini TIDAK meneruskan header pemanggil apa adanya. Worker membangun
 * profil header browser yang kecil dan konsisten sendiri. Kenapa?
 *
 * Kalau header dari pemanggil (mis. cf.js) diteruskan mentah — terutama
 * `Sec-Fetch-Site: same-origin` + `Origin` + `Sec-Ch-Ua` — sementara request
 * sebenarnya datang dari edge Cloudflare (bukan browser), Cloudflare di
 * sisi origin membaca itu sebagai "fake browser" dan menyajikan JS challenge
 * "Just a moment..." (status 403). Hasil yang sudah teruji: profil minimal
 * di bawah lolos, profil lengkap yang inkonsisten gagal.
 *
 * Set secret PROXY_SECRET di Worker Settings > Variables and Secrets.
 * Nilainya harus sama dengan PROXY_SECRET di Vercel/cf.js. Kalau secret
 * di-set, request tanpa X-Proxy-Secret yang cocok ditolak (403).
 *
 * Catatan: worker/CORS tidak bisa menyelesaikan JS challenge pada origin.
 * Kalau suatu saat origin kembali mem-bypass route API ini (mis. mengubah
 * rule WAF), tetap akan 403 — solusi jangka panjangnya adalah rule
 * Skip/Allow untuk route /3/2/* di Cloudflare origin, bukan ganti header.
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

// Profil browser SATU yang konsisten. Jangan menambah header identitas
// (Sec-Fetch-*, Sec-Ch-Ua, Origin) tanpa pengujian ulang — profil di bawah
// adalah yang terbukti lolos challenge.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Referer yang sama-site dengan target (animein.net -> animein.net, dst).
function refererFor(hostname) {
  if (/(^|\.)animein\.net$/i.test(hostname)) return 'https://animein.net/';
  if (/(^|\.)animeinweb\.com$/i.test(hostname)) return 'https://animeinweb.com/';
  return `https://${hostname}/`;
}

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

    // Gerbang secret: hanya aktif kalau PROXY_SECRET di-set di worker.
    // cf.js selalu mengirim X-Proxy-Secret, jadi ini tidak memengaruhi
    // traffic dari API — hanya memblokir pemakaian worker sebagai proxy umum.
    if (env.PROXY_SECRET && request.headers.get('X-Proxy-Secret') !== env.PROXY_SECRET) {
      return response('Bad or missing X-Proxy-Secret', { status: 403 });
    }

    // Bangun ulang header — JANGAN salin request.headers.
    const isVideo = target.hostname === 'storages.animein.net';
    const headers = new Headers();
    headers.set('User-Agent', UA);
    headers.set('Accept', isVideo ? '*/*' : 'application/json, text/plain, */*');
    headers.set('Accept-Language', 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7');
    headers.set('Referer', refererFor(target.hostname));
    headers.set('X-Requested-With', 'XMLHttpRequest');
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
    // Jangan paparkan hop-by-hop header dari origin.
    out.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
