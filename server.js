import express from 'express';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  baseApi,
  fetchJson,
  fetchBuffer,
  pipeTo,
  transportInfo,
  isAllowedProxyTarget,
  isAnimeinHost,
  isCloudflareChallenge,
  HttpError,
  proxyConfig
} from './cf.js';
import { TtlCache, ttl } from './lib/cache.js';
import { absoluteAsset, imageUrl, rewriteList, rewriteMovie, rewriteEpisode, publicOrigin } from './lib/images.js';
import {
  alPopular,
  alSearch,
  alByGenre,
  alOngoing,
  alDetail,
  alSchedule,
  ANILIST_GENRES
} from './lib/anilist.js';

dotenv.config({ quiet: true });

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', true);
app.disable('x-powered-by');

const cache = new TtlCache(500);

// ------------------------------------------------------------------ helpers
const DAYS = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU'];

const STATIC_GENRES = [
  { id: '14', name: 'Action', group: 'Genre' },
  { id: '16', name: 'Adventure', group: 'Genre' },
  { id: '25', name: 'Comedy', group: 'Genre' },
  { id: '43', name: 'Demons', group: 'Theme' },
  { id: '22', name: 'Drama', group: 'Genre' },
  { id: '27', name: 'Ecchi', group: 'Explicit' },
  { id: '38', name: 'Fantasy', group: 'Genre' },
  { id: '30', name: 'Game', group: 'Theme' },
  { id: '36', name: 'Harem', group: 'Theme' },
  { id: '46', name: 'Historical', group: 'Theme' },
  { id: '45', name: 'Horror', group: 'Genre' },
  { id: '44', name: 'Josei', group: 'Demographic' },
  { id: '42', name: 'Kids', group: 'Demographic' },
  { id: '40', name: 'Magic', group: 'Theme' },
  { id: '37', name: 'Martial Arts', group: 'Theme' },
  { id: '31', name: 'Mecha', group: 'Genre' },
  { id: '32', name: 'Military', group: 'Theme' },
  { id: '35', name: 'Music', group: 'Genre' },
  { id: '34', name: 'Mystery', group: 'Genre' },
  { id: '23', name: 'Parody', group: 'Theme' },
  { id: '47', name: 'Psychological', group: 'Genre' },
  { id: '17', name: 'Romance', group: 'Genre' },
  { id: '18', name: 'School', group: 'Theme' },
  { id: '19', name: 'Sci-Fi', group: 'Genre' },
  { id: '21', name: 'Seinen', group: 'Demographic' },
  { id: '20', name: 'Shoujo', group: 'Demographic' },
  { id: '24', name: 'Shounen', group: 'Demographic' },
  { id: '33', name: 'Slice of Life', group: 'Genre' },
  { id: '39', name: 'Space', group: 'Theme' },
  { id: '15', name: 'Sports', group: 'Genre' },
  { id: '41', name: 'Super Power', group: 'Theme' },
  { id: '26', name: 'Supernatural', group: 'Genre' },
  { id: '48', name: 'Thriller', group: 'Genre' },
  { id: '29', name: 'Vampire', group: 'Theme' }
];

const sortViews = 'sort=views';

function decodeTarget(raw) {
  let t = String(raw || '').trim();
  if (!/^https?:\/\//i.test(t)) {
    try { t = decodeURIComponent(t); } catch { /* biarkan */ }
  }
  // new URL otomatis meng-escape spasi/karakter ilegal tanpa merusak %20 yang sah
  try { t = new URL(t).href; } catch { /* biarkan */ }
  return t;
}

function q(req, name, def) {
  const v = req.query[name];
  if (v === undefined || v === null || v === '') return def;
  return Array.isArray(v) ? v[0] : v;
}

function pageOf(req) {
  const n = Number(q(req, 'page', 0));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function wantsRefresh(req) {
  const v = String(q(req, 'refresh', '')).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function errInfo(e) {
  if (e instanceof HttpError) return { message: e.message, status: e.statusCode || null, via: e.via || null };
  return { message: e?.message || String(e) };
}

function mark(res, { source, cached, stale, fallback, ttlMs, error }) {
  res.setHeader('X-Data-Source', source);
  if (cached) res.setHeader('X-Cache', stale ? 'STALE' : 'HIT');
  else res.setHeader('X-Cache', 'MISS');
  if (ttlMs) res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}, stale-while-revalidate=60`);
  else res.setHeader('Cache-Control', 'no-store');
  if (fallback) res.setHeader('X-Fallback', '1');
  if (error) res.setHeader('X-Upstream-Error', encodeURIComponent(String(error).slice(0, 180)));
}

// Ambil data upstream; kalau gagal -> pakai cache lama -> kalau tidak ada, lempar.
async function fromUpstream(key, ttlMs, loader, req) {
  if (!wantsRefresh(req)) {
    const hit = cache.get(key);
    if (hit) return { data: hit, cached: true, stale: false };
  }
  try {
    const data = await loader();
    cache.set(key, data, ttlMs);
    return { data, cached: false, stale: false };
  } catch (e) {
    const old = cache.stale(key);
    if (old) return { data: old, cached: true, stale: true, error: e.message };
    throw e;
  }
}

// --------------------------------------------------------------- middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, X-Cache, X-Data-Source, X-Fallback, X-Upstream-Error');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

if (String(process.env.LOG || '') === '1') {
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - t0}ms (${res.getHeader('X-Data-Source') || '-'})`);
    });
    next();
  });
}

// ----------------------------------------------------------------- root/health
app.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'Aisoft API is running',
    version: '2.1.0',
    docs: `${publicOrigin(req)}/v1/health`,
    endpoints: [
      '/v1/health',
      '/v1/genre',
      '/v1/genre?id=14&page=0',
      '/v1/popular?page=0',
      '/v1/search?q=naruto&page=0',
      '/v1/schedule',
      '/v1/schedule?day=SENIN',
      '/v1/ongoing',
      '/v1/detail?id=426&pages=3',
      '/v1/episodes?id=426&page=0',
      '/v1/episode?id=321196',
      '/v1/proxy?url=<encoded>&stream=1',
      '/v1/p/<file>.mp4?url=<encoded>',
      '/v1/img?url=<encoded>'
    ]
  });
});

app.get('/v1/health', async (req, res) => {
  const t0 = Date.now();
  const transport = await transportInfo();
  const checks = {};

  const timed = async (fn, ms = 9000) => {
    const started = Date.now();
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));
    try {
      const value = await Promise.race([fn(), timer]);
      return { ok: true, ms: Date.now() - started, value };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: e.message };
    }
  };

  const upstream = await timed(async () => {
    const json = await fetchJson(`${baseApi()}/explore/genre`, { timeout: 8000 });
    return Array.isArray(json?.data?.genre) ? json.data.genre.length : 0;
  });
  checks.upstream = upstream.ok
    ? { ok: true, latency_ms: upstream.ms, genre_count: upstream.value }
    : { ok: false, latency_ms: upstream.ms, error: upstream.error };

  const anilist = await timed(async () => {
    const r = await alPopular(0, 1);
    return r.list.length;
  });
  checks.anilist = anilist.ok
    ? { ok: true, latency_ms: anilist.ms, sample: anilist.value }
    : { ok: false, latency_ms: anilist.ms, error: anilist.error };

  res.json({
    status: true,
    version: '2.1.0',
    uptime_s: Math.round(process.uptime()),
    transport,
    config: proxyConfig(),
    checks,
    cache_entries: cache.size,
    total_ms: Date.now() - t0
  });
});

// --------------------------------------------------------------------- genre
async function upstreamGenres() {
  const json = await fetchJson(`${baseApi()}/explore/genre`, { timeout: 12000 });
  const list = Array.isArray(json?.data?.genre) ? json.data.genre : [];
  if (!list.length) throw new Error('genre upstream kosong');
  return list.map(g => ({ id: String(g.id), name: g.name, group: g.group, image: absoluteAsset(g.image) }));
}

app.get('/v1/genre', async (req, res) => {
  const id = q(req, 'id');
  const page = pageOf(req);

  // ---- daftar genre
  if (!id) {
    try {
      const { data, cached, stale, error } = await fromUpstream('genres', ttl.hours(6), upstreamGenres, req);
      mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.hours(6), error });
      return res.json({
        status: true,
        total: data.length,
        data: data.map(g => ({ ...g, image: imageUrl(req, g.image) })),
        ...(stale ? { stale: true, upstream_error: error } : {})
      });
    } catch (e) {
      const info = errInfo(e);
      const staticList = STATIC_GENRES.map(g => ({ ...g, image: null, source: 'static' }));
      mark(res, { source: 'static', fallback: true, ttlMs: ttl.minutes(2), error: info.message });
      return res.json({ status: true, data: staticList, fallback: true, static: true, upstream_error: info.message });
    }
  }

  // ---- filter genre
  const ids = String(id).split(',').map(s => s.trim()).filter(Boolean);
  const key = `genre:${ids.join(',')}:${page}`;
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(5),
      async () => {
        const params = ids.map(v => `genre_in=${encodeURIComponent(v)}`).join('&');
        const json = await fetchJson(`${baseApi()}/explore/movie?page=${page}&${params}`, { timeout: 15000 });
        const list = Array.isArray(json?.data?.movie) ? json.data.movie : [];
        if (!list.length) throw new Error('hasil genre kosong');
        return list;
      },
      req
    );
    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(5), error });
    return res.json({
      status: true,
      page,
      total: data.length,
      data: rewriteList(data, req),
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    const genreName = await resolveGenreName(ids[0]);
    try {
      const al = await alByGenre(genreName, page, 20);
      mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(3), error: info.message });
      return res.json({
        status: true,
        page,
        total: al.list.length,
        data: rewriteList(al.list, req),
        fallback: true,
        source: 'anilist',
        upstream_error: info.message
      });
    } catch (e2) {
      mark(res, { source: 'empty', fallback: true, error: info.message });
      return res.json({ status: true, page, total: 0, data: [], fallback: true, upstream_error: info.message, fallback_error: e2.message });
    }
  }
});

async function resolveGenreName(id) {
  if (!id) return 'Action';
  const hit = cache.get('genres');
  const list = hit || STATIC_GENRES;
  const found = list.find(g => String(g.id) === String(id));
  if (found) return found.name;
  if (ANILIST_GENRES.includes(String(id))) return String(id);
  return 'Action';
}

// ------------------------------------------------------------------- popular
app.get('/v1/popular', async (req, res) => {
  const page = pageOf(req);
  const key = `popular:${page}`;
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(5),
      async () => {
        const json = await fetchJson(`${baseApi()}/explore/movie?${sortViews}&page=${page}`, { timeout: 15000 });
        const list = Array.isArray(json?.data?.movie) ? json.data.movie : [];
        if (!list.length) throw new Error('popular kosong');
        return list;
      },
      req
    );
    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(5), error });
    return res.json({
      status: true,
      page,
      total: data.length,
      data: rewriteList(data, req),
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    try {
      const al = await alPopular(page, 20);
      mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(3), error: info.message });
      return res.json({ status: true, page, total: al.list.length, data: rewriteList(al.list, req), fallback: true, source: 'anilist', upstream_error: info.message });
    } catch (e2) {
      mark(res, { source: 'empty', fallback: true, error: info.message });
      return res.json({ status: true, page, total: 0, data: [], fallback: true, upstream_error: info.message, fallback_error: e2.message });
    }
  }
});

// -------------------------------------------------------------------- search
app.get('/v1/search', async (req, res) => {
  const keyword = String(q(req, 'q', q(req, 'keyword', '')) || '').trim();
  const page = pageOf(req);
  if (!keyword) return res.json({ status: true, page, total: 0, data: [], message: 'parameter q kosong' });

  const key = `search:${keyword.toLowerCase()}:${page}`;
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(3),
      async () => {
        const json = await fetchJson(`${baseApi()}/explore/movie?keyword=${encodeURIComponent(keyword)}&page=${page}`, { timeout: 15000 });
        return Array.isArray(json?.data?.movie) ? json.data.movie : [];
      },
      req
    );
    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(3), error });
    return res.json({
      status: true,
      q: keyword,
      page,
      total: data.length,
      data: rewriteList(data, req),
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    try {
      const al = await alSearch(keyword, page, 20);
      mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(3), error: info.message });
      return res.json({ status: true, q: keyword, page, total: al.list.length, data: rewriteList(al.list, req), fallback: true, source: 'anilist', upstream_error: info.message });
    } catch (e2) {
      mark(res, { source: 'empty', fallback: true, error: info.message });
      return res.json({ status: true, q: keyword, page, total: 0, data: [], fallback: true, upstream_error: info.message, fallback_error: e2.message });
    }
  }
});

// ------------------------------------------------------------------ schedule
function scheduleKey(day) {
  return `schedule:${day || 'ALL'}`;
}

async function loadScheduleAll() {
  const results = await Promise.all(
    DAYS.map(async day => {
      try {
        const json = await fetchJson(`${baseApi()}/schedule/data?day=${day}`, { timeout: 12000 });
        return [day, Array.isArray(json?.data?.movie) ? json.data.movie : []];
      } catch {
        return [day, []];
      }
    })
  );
  const out = {};
  let total = 0;
  for (const [day, list] of results) {
    out[day] = list;
    total += list.length;
  }
  if (!total) throw new Error('semua hari kosong');
  return out;
}

app.get('/v1/schedule', async (req, res) => {
  const day = String(q(req, 'day', '') || '').toUpperCase();
  const single = DAYS.includes(day);

  try {
    const { data, cached, stale, error } = await fromUpstream(
      scheduleKey(single ? day : null),
      ttl.minutes(5),
      async () => {
        if (single) {
          const json = await fetchJson(`${baseApi()}/schedule/data?day=${day}`, { timeout: 12000 });
          const list = Array.isArray(json?.data?.movie) ? json.data.movie : [];
          if (!list.length) throw new Error(`jadwal ${day} kosong`);
          return list;
        }
        return loadScheduleAll();
      },
      req
    );

    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(5), error });

    if (single) {
      return res.json({
        status: true,
        day,
        total: data.length,
        data: rewriteList(data, req),
        ...(stale ? { stale: true, upstream_error: error } : {})
      });
    }

    const out = {};
    let total = 0;
    for (const d of DAYS) {
      out[d] = rewriteList(data[d] || [], req);
      total += out[d].length;
    }
    return res.json({ status: true, total, days: DAYS, data: out, ...(stale ? { stale: true, upstream_error: error } : {}) });
  } catch (e) {
    const info = errInfo(e);
    try {
      const al = await alSchedule(single ? day : null);
      mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(3), error: info.message });
      if (single) {
        return res.json({ status: true, day, total: al.length, data: rewriteList(al, req), fallback: true, source: 'anilist', upstream_error: info.message });
      }
      const out = {};
      for (const d of DAYS) out[d] = rewriteList(al.filter(m => m.day === d), req);
      out.RANDOM = rewriteList(al, req);
      return res.json({ status: true, total: al.length, days: [...DAYS, 'RANDOM'], data: out, fallback: true, source: 'anilist', upstream_error: info.message });
    } catch (e2) {
      mark(res, { source: 'empty', fallback: true, error: info.message });
      const out = {};
      for (const d of DAYS) out[d] = [];
      out.RANDOM = [];
      return res.json({ status: true, total: 0, days: [...DAYS, 'RANDOM'], data: out, fallback: true, upstream_error: info.message, fallback_error: e2.message });
    }
  }
});

// ------------------------------------------------------------------- ongoing
app.get('/v1/ongoing', async (req, res) => {
  const key = 'ongoing';
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(5),
      async () => {
        const schedule = await loadScheduleAll();
        const seen = new Set();
        const list = [];
        for (const day of [...DAYS, 'RANDOM']) {
          for (const m of schedule[day] || []) {
            const isOngoing = String(m.status || '').toUpperCase() === 'ONGOING';
            if (!isOngoing || seen.has(m.id)) continue;
            seen.add(m.id);
            list.push(m);
          }
        }
        if (!list.length) throw new Error('tidak ada anime ongoing');
        return list;
      },
      req
    );
    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(5), error });
    return res.json({ status: true, total: data.length, data: rewriteList(data, req), ...(stale ? { stale: true, upstream_error: error } : {}) });
  } catch (e) {
    const info = errInfo(e);
    try {
      const al = await alOngoing(25);
      mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(3), error: info.message });
      return res.json({ status: true, total: al.list.length, data: rewriteList(al.list, req), fallback: true, source: 'anilist', upstream_error: info.message });
    } catch (e2) {
      mark(res, { source: 'empty', fallback: true, error: info.message });
      return res.json({ status: true, total: 0, data: [], fallback: true, upstream_error: info.message, fallback_error: e2.message });
    }
  }
});

// -------------------------------------------------------------------- detail
app.get('/v1/episodes', async (req, res) => {
  const id = String(q(req, 'id', '') || '').trim();
  const page = pageOf(req);
  if (!id) return res.status(400).json({ status: false, message: 'parameter id wajib diisi' });

  const key = `episodes:${id}:${page}`;
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(10),
      async () => {
        const json = await fetchJson(`${baseApi()}/movie/episode/${encodeURIComponent(id)}?page=${page}`, { timeout: 15000 });
        return Array.isArray(json?.data?.episode) ? json.data.episode : [];
      },
      req
    );
    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(10), error });
    return res.json({
      status: true,
      id,
      page,
      total: data.length,
      data: data.map(ep => rewriteEpisode(ep, req)),
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    mark(res, { source: 'empty', fallback: true, error: info.message });
    return res.json({ status: true, id, page, total: 0, data: [], upstream_error: info.message });
  }
});

app.get('/v1/detail', async (req, res) => {
  const id = String(q(req, 'id', '') || '').trim();
  if (!id) return res.status(400).json({ status: false, message: 'parameter id wajib diisi' });

  const maxPages = Math.min(Math.max(Number(q(req, 'pages', 3)) || 3, 1), 40);
  const key = `detail:${id}:${maxPages}`;

  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.minutes(10),
      async () => {
        const detail = await fetchJson(`${baseApi()}/movie/detail/${encodeURIComponent(id)}`, { timeout: 15000 });
        const movie = detail?.data?.movie;
        if (!movie) throw new Error('detail tidak ditemukan');

        const pages = [];
        for (let p = 0; p < maxPages; p++) pages.push(p);
        const collected = [];
        let exhausted = false;
        let fetched = 0;

        // ambil 3 halaman sekaligus biar tidak terlalu banyak proses curl
        for (let i = 0; i < pages.length && !exhausted; i += 3) {
          const batch = pages.slice(i, i + 3);
          const results = await Promise.all(
            batch.map(p =>
              fetchJson(`${baseApi()}/movie/episode/${encodeURIComponent(id)}?page=${p}`, { timeout: 15000 })
                .then(json => (Array.isArray(json?.data?.episode) ? json.data.episode : []))
                .catch(() => [])
            )
          );
          for (const list of results) {
            fetched += 1;
            if (!list.length) exhausted = true;
            else collected.push(...list);
          }
        }

        return {
          movie,
          latest_episode: detail?.data?.episode || null,
          season: Array.isArray(detail?.data?.season) ? detail.data.season : [],
          episodes: collected,
          pages_scanned: fetched,
          has_more: !exhausted && maxPages >= 1 && collected.length >= maxPages * 30
        };
      },
      req
    );

    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.minutes(10), error });
    return res.json({
      status: true,
      data: {
        ...rewriteMovie(data.movie, req),
        latest_episode: rewriteEpisode(data.latest_episode, req),
        season: data.season,
        episode_list: data.episodes.map(ep => rewriteEpisode(ep, req)),
        episode_count: data.episodes.length,
        pages_scanned: data.pages_scanned,
        has_more: data.has_more,
        episode_pages: data.episodes.length ? Math.ceil(data.episodes.length / 30) : 0
      },
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    if (/^\d+$/.test(id)) {
      try {
        const al = await alDetail(id);
        mark(res, { source: 'anilist', fallback: true, ttlMs: ttl.minutes(5), error: info.message });
        return res.json({
          status: true,
          fallback: true,
          source: 'anilist',
          data: { ...rewriteMovie(al, req), latest_episode: null, season: [], episode_list: [], episode_count: 0, has_more: false },
          upstream_error: info.message
        });
      } catch { /* jatuh ke error di bawah */ }
    }
    mark(res, { source: 'error', ttlMs: 0, error: info.message });
    return res.status(502).json({ status: false, message: 'Gagal mengambil detail', detail: info });
  }
});

// ------------------------------------------------------------------- episode
app.get('/v1/episode', async (req, res) => {
  const id = String(q(req, 'id', '') || '').trim();
  if (!id) return res.status(400).json({ status: false, message: 'parameter id (id episode) wajib diisi' });

  const key = `stream:${id}`;
  try {
    const { data, cached, stale, error } = await fromUpstream(
      key,
      ttl.hours(2),
      async () => {
        const json = await fetchJson(`${baseApi()}/episode/streamnew/${encodeURIComponent(id)}`, { timeout: 15000 });
        if (!json?.data) throw new Error('stream tidak ditemukan');
        return json.data;
      },
      req
    );

    const origin = publicOrigin(req);
    const servers = (Array.isArray(data.server) ? data.server : []).map(s => {
      const raw = s.link || '';
      // Frontend (Nefusoft) memutar video lewat helper yang membungkus URL apa pun
      // ke cf.tiyanstores.workers.dev lalu mengecek `link.split('?')[0].endsWith('.mp4')`.
      // CDN animein menolak worker (403) dan menolak browser tanpa Referer, jadi
      // `link` sengaja diarahkan ke proxy milik API ini dengan path berakhiran .mp4.
      const quality = String(s.quality || 'auto').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'auto';
      const proxyName = `${id}-${quality}.mp4`;
      return {
        ...s,
        link: raw ? `${origin}/v1/p/${proxyName}?url=${encodeURIComponent(raw)}` : raw,
        source_url: raw || null,
        play_url: raw ? `${origin}/v1/proxy?url=${encodeURIComponent(raw)}` : null,
        stream_url: raw ? `${origin}/v1/proxy?url=${encodeURIComponent(raw)}&stream=1` : null
      };
    });

    mark(res, { source: 'upstream', cached, stale, ttlMs: ttl.hours(2), error });
    return res.json({
      status: true,
      data: {
        episode: rewriteEpisode(data.episode || {}, req),
        server: servers,
        servers,
        next_episode: data.episode_next || null,
        prev_episode: data.episode_prev || null
      },
      ...(stale ? { stale: true, upstream_error: error } : {})
    });
  } catch (e) {
    const info = errInfo(e);
    mark(res, { source: 'error', ttlMs: 0, error: info.message });
    return res.status(502).json({ status: false, message: 'Gagal mengambil link streaming', detail: info });
  }
});

// ------------------------------------------------------------- stream (.mp4 path)
// Alias /v1/proxy dengan nama file berakhiran .mp4, dipakai player web yang
// mendeteksi direct-mp4 lewat akhiran path.
app.get(['/v1/p', '/v1/p/:file'], async (req, res) => {
  const raw = q(req, 'url', '');
  if (!raw) return res.status(400).json({ status: false, message: 'parameter url wajib diisi' });

  const target = decodeTarget(raw);
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ status: false, message: 'url harus http(s) absolute' });
  if (!isAllowedProxyTarget(target)) {
    return res.status(403).json({ status: false, message: 'host tidak diizinkan', hint: 'hanya *.animein.net / animeinweb.com' });
  }

  try {
    const range = req.headers.range;
    const out = await pipeTo(target, res, { range });
    res.setHeader('X-Proxy-Via', out.via);
    res.setHeader('X-Proxy-Upstream', String(out.upstream));
  } catch (e) {
    const info = errInfo(e);
    if (!res.headersSent) {
      res.status(502).json({ status: false, message: 'Gagal mem-proxy', detail: info });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

// --------------------------------------------------------------------- proxy
app.get(['/v1/proxy', '/v1/proxy/:file'], async (req, res) => {
  const raw = q(req, 'url', '');
  if (!raw) return res.status(400).json({ status: false, message: 'parameter url wajib diisi' });

  const target = decodeTarget(raw);
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ status: false, message: 'url harus http(s) absolute' });
  if (!isAllowedProxyTarget(target)) {
    return res.status(403).json({ status: false, message: 'host tidak diizinkan', hint: 'hanya *.animein.net / animeinweb.com' });
  }

  const stream = ['1', 'true', 'yes'].includes(String(q(req, 'stream', '')).toLowerCase());
  const mode = String(process.env.PROXY_MODE || 'redirect').toLowerCase();
  const shouldStream = stream || mode === 'pipe' || req.method === 'HEAD';

  if (!shouldStream) {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, target);
  }

  try {
    const range = req.headers.range;
    const out = await pipeTo(target, res, { range });
    res.setHeader('X-Proxy-Via', out.via);
    res.setHeader('X-Proxy-Upstream', String(out.upstream));
  } catch (e) {
    const info = errInfo(e);
    if (!res.headersSent) {
      res.status(502).json({ status: false, message: 'Gagal mem-proxy', detail: info });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

// ----------------------------------------------------------------------- img
app.get('/v1/img', async (req, res) => {
  const raw = q(req, 'url', '');
  if (!raw) return res.status(400).json({ status: false, message: 'parameter url wajib diisi' });

  const target = decodeTarget(raw);
  if (!/^https?:\/\//i.test(target) || !isAnimeinHost(target)) {
    return res.status(403).json({ status: false, message: 'hanya gambar dari host animein yang diproxy' });
  }

  const memKey = `img:${target}`;
  const hit = cache.get(memKey);
  if (hit) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Cache', 'HIT');
    return res.end(hit.buffer);
  }

  try {
    const { status, buffer } = await fetchBuffer(target, { timeout: 15000, maxBytes: 12 * 1024 * 1024 });
    if (status !== 200 || !buffer?.length) {
      return res.status(502).json({ status: false, message: `upstream gambar ${status}` });
    }
    let type = 'application/octet-stream';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) type = 'image/jpeg';
    else if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) type = 'image/png';
    else if (buffer.slice(0, 4).toString() === 'GIF8') type = 'image/gif';
    else if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') type = 'image/webp';

    cache.set(memKey, { buffer, type }, ttl.hours(6));
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Cache', 'MISS');
    return res.end(buffer);
  } catch (e) {
    const info = errInfo(e);
    return res.status(502).json({ status: false, message: 'Gagal mengambil gambar', detail: info });
  }
});

// ------------------------------------------------------------------------ 404
app.use((req, res) => {
  res.status(404).json({
    status: false,
    message: 'Endpoint tidak ditemukan',
    available: ['/v1/health', '/v1/genre', '/v1/popular', '/v1/search', '/v1/schedule', '/v1/ongoing', '/v1/detail', '/v1/episodes', '/v1/episode', '/v1/proxy', '/v1/p/<file>.mp4', '/v1/img']
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled:', err?.message || err);
  if (res.headersSent) return res.end();
  res.status(500).json({ status: false, message: 'Internal error', detail: { message: err?.message || String(err) } });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    console.log(`Aisoft API listening on http://127.0.0.1:${PORT}`);
    console.log(`  transport : auto (curl diutamakan)`);
    console.log(`  base api  : ${baseApi()}`);
  });
}

export default app;
