// Normalisasi URL gambar dari upstream.
//
// Upstream mengirim tiga bentuk:
//   1. https://xyz-api.animein.net//assets_xyz/images/movie/poster/xxx.jpg  (dobel slash)
//   2. /assets_xyz/images/movie/episode/xxx.jpg                            (relatif)
//   3. https://animein.net/assets/images/genres/xxx.png                    (host lain)
//
// Semua host animein memblokir request tanpa Referer https://animeinweb.com/,
// jadi default kita salurkan lewat endpoint /v1/img milik API ini.
const ASSET_ORIGIN = 'https://xyz-api.animein.net';
const SITE_ORIGIN = 'https://animein.net';

function collapsePath(u) {
  try {
    const x = new URL(u);
    x.pathname = x.pathname.replace(/\/{2,}/g, '/');
    return x.toString();
  } catch {
    return u;
  }
}

export function absoluteAsset(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!u) return null;
  if (u.startsWith('//')) u = `https:${u}`;
  else if (u.startsWith('/assets_xyz/')) u = ASSET_ORIGIN + u;
  else if (u.startsWith('/assets/')) u = SITE_ORIGIN + u;
  else if (u.startsWith('/')) u = ASSET_ORIGIN + u;
  if (!/^https?:\/\//i.test(u)) return null;
  return collapsePath(u);
}

export function isAnimeinAsset(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'animein.net' || h.endsWith('.animein.net');
  } catch {
    return false;
  }
}

export function assetMode() {
  const m = String(process.env.IMG_MODE || 'proxy').toLowerCase();
  return ['proxy', 'direct', 'source'].includes(m) ? m : 'proxy';
}

export function publicOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '127.0.0.1').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function imageUrl(req, raw) {
  const abs = absoluteAsset(raw);
  if (!abs) return null;
  const mode = assetMode();
  if (mode === 'source') return abs;
  if (mode === 'direct' || !isAnimeinAsset(abs)) return abs;
  return `${publicOrigin(req)}/v1/img?url=${encodeURIComponent(abs)}`;
}

function splitGenre(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

export function rewriteMovie(movie, req) {
  if (!movie || typeof movie !== 'object') return movie;
  const out = { ...movie };
  const posterRaw = movie.image_poster || movie.poster || movie.image;
  const coverRaw = movie.image_cover || movie.cover || movie.banner;

  out.image_poster = imageUrl(req, posterRaw);
  out.image_cover = imageUrl(req, coverRaw);
  out.poster = out.image_poster;
  out.genres = splitGenre(movie.genre || movie.genres);
  if (movie.genre) out.genre = splitGenre(movie.genre).join(', ');
  if (movie.status) {
    const s = String(movie.status).toUpperCase();
    out.status = s === 'FINISHED' || s === 'COMPLETED' ? 'COMPLETED' : s === 'ONGOING' || s === 'RELEASING' ? 'ONGOING' : s;
  }
  out.views = movie.views !== undefined ? Number(movie.views) || 0 : movie.views;
  out.favorites = movie.favorites !== undefined ? Number(movie.favorites) || 0 : movie.favorites;
  return out;
}

export function rewriteList(list, req) {
  if (!Array.isArray(list)) return [];
  return list.map(m => rewriteMovie(m, req));
}

export function rewriteEpisode(ep, req) {
  if (!ep || typeof ep !== 'object') return ep;
  const out = { ...ep };
  out.image = imageUrl(req, ep.image || ep.image_episode);
  out.index = ep.index !== undefined ? Number(ep.index) || ep.index : ep.index;
  out.views = ep.views !== undefined ? Number(ep.views) || 0 : ep.views;
  return out;
}
