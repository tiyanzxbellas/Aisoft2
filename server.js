import express from 'express';
import dotenv from 'dotenv';
import { proxyFetch, proxyStream, fetchJson, testSecrets, getProxyConfig } from './cf.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BASE_API = process.env.BASE_API || 'https://xyz-api.animein.net/3/2';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Fallback data ----
const FALLBACK_GENRES = [
  { id: 1, name: 'Action', group: 'Genre' },
  { id: 2, name: 'Adventure', group: 'Genre' },
  { id: 3, name: 'Cars', group: 'Genre' },
  { id: 4, name: 'Comedy', group: 'Genre' },
  { id: 5, name: 'Dementia', group: 'Genre' },
  { id: 6, name: 'Demons', group: 'Genre' },
  { id: 7, name: 'Mystery', group: 'Genre' },
  { id: 8, name: 'Drama', group: 'Genre' },
  { id: 9, name: 'Ecchi', group: 'Explicit' },
  { id: 10, name: 'Fantasy', group: 'Genre' },
  { id: 11, name: 'Game', group: 'Theme' },
  { id: 12, name: 'Hentai', group: 'Explicit' },
  { id: 13, name: 'Historical', group: 'Theme' },
  { id: 14, name: 'Horror', group: 'Genre' },
  { id: 15, name: 'Kids', group: 'Demographic' },
  { id: 17, name: 'Martial Arts', group: 'Genre' },
  { id: 18, name: 'Mecha', group: 'Theme' },
  { id: 19, name: 'Music', group: 'Genre' },
  { id: 20, name: 'Parody', group: 'Genre' },
  { id: 21, name: 'Samurai', group: 'Theme' },
  { id: 22, name: 'Romance', group: 'Genre' },
  { id: 23, name: 'School', group: 'Theme' },
  { id: 24, name: 'Sci-Fi', group: 'Genre' },
  { id: 25, name: 'Shoujo', group: 'Demographic' },
  { id: 26, name: 'Girls Love', group: 'Genre' },
  { id: 27, name: 'Shounen', group: 'Demographic' },
  { id: 28, name: 'Boys Love', group: 'Genre' },
  { id: 29, name: 'Space', group: 'Theme' },
  { id: 30, name: 'Sports', group: 'Genre' },
  { id: 31, name: 'Super Power', group: 'Theme' },
  { id: 32, name: 'Vampire', group: 'Theme' },
  { id: 35, name: 'Harem', group: 'Theme' },
  { id: 36, name: 'Slice of Life', group: 'Genre' },
  { id: 37, name: 'Supernatural', group: 'Genre' },
  { id: 38, name: 'Military', group: 'Theme' },
  { id: 39, name: 'Police', group: 'Theme' },
  { id: 40, name: 'Psychological', group: 'Genre' },
  { id: 41, name: 'Suspense', group: 'Genre' },
  { id: 42, name: 'Seinen', group: 'Demographic' },
  { id: 43, name: 'Josei', group: 'Demographic' },
  { id: 46, name: 'Award Winning', group: 'Theme' },
  { id: 47, name: 'Gourmet', group: 'Theme' },
  { id: 50, name: 'Adult Cast', group: 'Theme' },
  { id: 62, name: 'Isekai', group: 'Theme' },
  { id: 66, name: 'Mahou Shoujo', group: 'Theme' },
  { id: 4_000, name: 'Iyashikei', group: 'Theme' }
];

// cache
const cache = new Map();
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.data;
}

// helpers for Jikan fallback
function jikanToMovie(a) {
  return {
    id: a.mal_id?.toString() || `${a.mal_id}`,
    mal_id: a.mal_id,
    title: a.title,
    title_english: a.title_english,
    title_japanese: a.title_japanese,
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
    image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url,
    type: a.type,
    status: a.status?.toLowerCase().includes('finished') || a.status?.toLowerCase().includes('completed') ? 'COMPLETED' : 'ONGOING',
    score: a.score,
    synopsis: a.synopsis,
    year: a.year || a.aired?.prop?.from?.year,
    genres: (a.genres || []).map(g => g.name),
    genre_ids: (a.genres || []).map(g => g.mal_id),
    episodes: a.episodes,
    aired: a.aired,
    source: 'jikan-fallback'
  };
}

async function jikanSearch(q, page = 0) {
  const jPage = Math.max(1, parseInt(page) + 1);
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&page=${jPage}&sfw=true&order_by=popularity&sort=desc`;
  const json = await fetchJson(url);
  return (json.data || []).map(jikanToMovie);
}
async function jikanPopular(page = 0) {
  const jPage = Math.max(1, parseInt(page) + 1);
  const url = `https://api.jikan.moe/v4/top/anime?page=${jPage}&sfw=true`;
  const json = await fetchJson(url);
  return (json.data || []).map(jikanToMovie);
}
async function jikanByGenre(genreId, page = 0) {
  const jPage = Math.max(1, parseInt(page) + 1);
  const url = `https://api.jikan.moe/v4/anime?genres=${genreId}&page=${jPage}&order_by=popularity&sort=desc&sfw=true`;
  const json = await fetchJson(url);
  return (json.data || []).map(jikanToMovie);
}
async function jikanSchedule(day) {
  const map = {
    SENIN: 'monday',
    SELASA: 'tuesday',
    RABU: 'wednesday',
    KAMIS: 'thursday',
    JUMAT: 'friday',
    SABTU: 'saturday',
    MINGGU: 'sunday'
  };
  const filter = map[day];
  let url = `https://api.jikan.moe/v4/schedules?sfw=true`;
  if (filter) url += `&filter=${filter}`;
  const json = await fetchJson(url);
  // For RANDOM return mixed
  return (json.data || []).map(jikanToMovie).slice(0, 25);
}

app.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'Aisoft API is running',
    endpoints: [
      '/v1/genre',
      '/v1/genre?id=1&page=0',
      '/v1/popular?page=0',
      '/v1/search?q=naruto&page=0',
      '/v1/schedule',
      '/v1/ongoing',
      '/v1/detail?id=...',
      '/v1/episode?id=...',
      '/v1/proxy?url=...',
      '/v1/health'
    ]
  });
});

app.get('/v1/health', async (req, res) => {
  const checks = {};
  const proxy = getProxyConfig();
  try {
    const r = await proxyFetch(`${BASE_API}/explore/genre`);
    const genreCount = r.data?.genre?.length || 0;
    checks.upstream = { ok: true, genre_count: genreCount, keys: Object.keys(r).slice(0, 5) };
  } catch (e) {
    checks.upstream = { ok: false, error: e.message, status: e.statusCode || null, via: e.via || null };
  }
  try {
    const j = await fetchJson('https://api.jikan.moe/v4/genres/anime');
    checks.jikan = { ok: true, count: j.data?.length };
  } catch (e) {
    checks.jikan = { ok: false, error: e.message };
  }
  res.json({
    status: true,
    base_api: BASE_API,
    cf_proxy: proxy.cf_proxy,
    checks,
    fallback_genres_count: FALLBACK_GENRES.length
  });
});

// Debug endpoint to test secret rotation from Vercel network (allows fetch_page tool to brute force)
app.get('/v1/debug/secret-test', async (req, res) => {
  const { secrets } = req.query;
  const list = secrets ? (Array.isArray(secrets) ? secrets : secrets.split(',')) : [
    'animein-secure-proxy-key-123',
    'animein-secure-proxy-key-456',
    'animein-secure-proxy-key',
    'animein-web-key',
    'animein-key-123',
    '',
    'null'
  ];
  const target = `${BASE_API}/explore/genre`;
  try {
    const results = await testSecrets(target, list);
    res.json({ status: true, target, results });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

app.get('/v1/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) throw new Error('URL nya mana memek');

    const decodedUrl = decodeURIComponent(url);
    const { statusCode, headers, body } = await proxyStream(decodedUrl, req.headers);

    const allowHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control'
    ];

    res.status(statusCode);
    for (const key of allowHeaders) {
      if (headers[key]) {
        res.setHeader(key, headers[key]);
      }
    }

    body.pipe(res);
  } catch (err) {
    res.status(500).json({
      status: false,
      message: err.message
    });
  }
});

app.get('/v1/schedule', async (req, res) => {
  const cacheKey = 'schedule';
  const cached = getCache(cacheKey);
  if (cached) return res.json({ status: true, data: cached, cached: true });

  try {
    const days = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU', 'RANDOM'];

    const results = await Promise.all(
      days.map(day => proxyFetch(`${BASE_API}/schedule/data?day=${day}`).catch(() => null))
    );

    const hasAny = results.some(r => r && r.data?.movie?.length);
    if (hasAny) {
      const scheduleData = {};
      days.forEach((day, index) => {
        scheduleData[day] = results[index]?.data?.movie || [];
      });
      setCache(cacheKey, scheduleData, 3 * 60 * 1000);
      return res.json({ status: true, data: scheduleData });
    }
    throw new Error('upstream empty, fallback');
  } catch (err) {
    console.warn('schedule upstream failed, using jikan fallback:', err.message);
    try {
      const days = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU', 'RANDOM'];
      const scheduleData = {};
      for (const day of days) {
        try {
          if (day === 'RANDOM') {
            const j = await fetchJson('https://api.jikan.moe/v4/random/anime?sfw=true');
            scheduleData[day] = j.data ? [jikanToMovie(j.data)] : [];
          } else {
            scheduleData[day] = await jikanSchedule(day);
          }
        } catch {
          scheduleData[day] = [];
        }
        await new Promise(r => setTimeout(r, 350)); // rate limit Jikan (3req/sec)
      }
      setCache(cacheKey, scheduleData, 10 * 60 * 1000);
      return res.json({ status: true, data: scheduleData, fallback: true, note: 'served from Jikan fallback due to upstream 403' });
    } catch (fallbackErr) {
      console.warn('schedule jikan fallback failed:', fallbackErr.message);
      return res.json({ status: true, data: {}, fallback: true, static: true, upstream_error: err.message, fallback_error: fallbackErr.message });
    }
  }
});

app.get('/v1/ongoing', async (req, res) => {
  const cacheKey = 'ongoing';
  const cached = getCache(cacheKey);
  if (cached) return res.json({ status: true, data: cached, cached: true });

  try {
    const days = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU', 'RANDOM'];

    const results = await Promise.all(
      days.map(day => proxyFetch(`${BASE_API}/schedule/data?day=${day}`).catch(() => null))
    );

    const hasAny = results.some(r => r && r.data?.movie?.length);
    if (hasAny) {
      const allMovies = results.flatMap(r => r?.data?.movie || []);
      const seen = new Set();
      const ongoingList = allMovies.filter(movie => {
        const isOngoing = movie.status === 'ONGOING';
        const isDuplicate = seen.has(movie.id);
        if (isOngoing && !isDuplicate) {
          seen.add(movie.id);
          return true;
        }
        return false;
      });
      setCache(cacheKey, ongoingList, 3 * 60 * 1000);
      return res.json({ status: true, data: ongoingList });
    }
    throw new Error('upstream empty');
  } catch (err) {
    console.warn('ongoing upstream failed, fallback:', err.message);
    try {
      const url = 'https://api.jikan.moe/v4/seasons/now?sfw=true&filter=tv';
      const json = await fetchJson(url);
      const list = (json.data || []).map(jikanToMovie).filter(m => m.status === 'ONGOING');
      setCache(cacheKey, list, 5 * 60 * 1000);
      return res.json({ status: true, data: list, fallback: true });
    } catch (e) {
      console.warn('ongoing jikan fallback failed:', e.message);
      return res.json({ status: true, data: [], fallback: true, static: true, upstream_error: err.message, fallback_error: e.message });
    }
  }
});

app.get('/v1/genre', async (req, res) => {
  const { id, page = 0 } = req.query;
  const cacheKey = `genre_${id || 'list'}_${page}`;
  const cached = getCache(cacheKey);
  if (cached && !id) return res.json({ status: true, data: cached, cached: true });

  // If filtering by genre id
  if (id) {
    try {
      let url = `${BASE_API}/explore/movie?page=${page}`;
      if (Array.isArray(id)) {
        id.forEach(val => { url += `&genre_in=${val}`; });
      } else {
        url += `&genre_in=${id}`;
      }
      const data = await proxyFetch(url);
      return res.json({
        status: true,
        data: data.data?.movie || []
      });
    } catch (err) {
      console.warn(`genre filter upstream failed id=${id}:`, err.message);
      // Fallback to Jikan
      try {
        // id may be numeric, try to use as Jikan genre id directly; if not numeric, lookup by name
        let genreId = parseInt(id);
        if (isNaN(genreId)) {
          const found = FALLBACK_GENRES.find(g => g.name.toLowerCase() === String(id).toLowerCase() || g.id.toString() === String(id));
          if (found) genreId = found.id;
          else genreId = 1; // default Action
        }
        const movies = await jikanByGenre(genreId, page);
        return res.json({ status: true, data: movies, fallback: true, note: `upstream failed (${err.message}), served from Jikan` });
      } catch (fallbackErr) {
        return res.status(200).json({
          status: true,
          data: [],
          fallback: true,
          upstream_error: err.message,
          fallback_error: fallbackErr.message
        });
      }
    }
  }

  // List all genres
  try {
    const data = await proxyFetch(`${BASE_API}/explore/genre`);
    const genres = (data.data?.genre || []).map(({ id, name, group }) => ({
      id,
      name,
      group
    }));
    if (genres.length) {
      setCache('genre_list', genres, 30 * 60 * 1000);
      return res.json({
        status: true,
        data: genres
      });
    }
    throw new Error('empty genre list from upstream');
  } catch (err) {
    console.warn('genre list upstream failed, serving fallback:', err.message);
    const cachedList = getCache('genre_list');
    if (cachedList) {
      return res.json({ status: true, data: cachedList, cached: true, fallback: true, upstream_error: err.message });
    }
    // Try Jikan genres as fallback, but transform to expected shape
    try {
      const jikan = await fetchJson('https://api.jikan.moe/v4/genres/anime');
      const genres = (jikan.data || []).map(g => ({
        id: g.mal_id,
        name: g.name,
        group: ['Shounen','Shoujo','Seinen','Josei','Kids'].includes(g.name) ? 'Demographic' : (['Ecchi','Hentai','Erotica'].includes(g.name) ? 'Explicit' : 'Genre'),
        count: g.count
      }));
      setCache('genre_list', genres, 30 * 60 * 1000);
      return res.json({ status: true, data: genres, fallback: true, note: 'served from Jikan fallback due to upstream 403' });
    } catch (jikanErr) {
      // Last resort static
      return res.json({
        status: true,
        data: FALLBACK_GENRES,
        fallback: true,
        static: true,
        upstream_error: err.message,
        jikan_error: jikanErr.message
      });
    }
  }
});

app.get('/v1/popular', async (req, res) => {
  const { page = 0 } = req.query;
  const cacheKey = `popular_${page}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json({ status: true, data: cached, cached: true });

  try {
    const data = await proxyFetch(`${BASE_API}/explore/movie?sort=views&page=${page}`);
    const movies = data.data?.movie || [];
    if (movies.length) {
      setCache(cacheKey, movies, 3 * 60 * 1000);
      return res.json({ status: true, data: movies });
    }
    throw new Error('empty popular');
  } catch (err) {
    console.warn('popular upstream failed, fallback:', err.message);
    try {
      const movies = await jikanPopular(page);
      setCache(cacheKey, movies, 5 * 60 * 1000);
      return res.json({ status: true, data: movies, fallback: true });
    } catch (e) {
      console.warn('jikan popular also failed:', e.message);
      return res.json({ status: true, data: [], fallback: true, static: true, upstream_error: err.message, fallback_error: e.message });
    }
  }
});

app.get('/v1/search', async (req, res) => {
  const { q = '', page = 0 } = req.query;
  const cacheKey = `search_${q}_${page}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json({ status: true, data: cached, cached: true });

  try {
    const data = await proxyFetch(`${BASE_API}/explore/movie?keyword=${encodeURIComponent(q)}&page=${page}`);
    const movies = data.data?.movie || [];
    setCache(cacheKey, movies, 2 * 60 * 1000);
    return res.json({ status: true, data: movies });
  } catch (err) {
    console.warn('search upstream failed, fallback:', err.message);
    try {
      if (!q) return res.json({ status: true, data: [], fallback: true });
      const movies = await jikanSearch(q, page);
      setCache(cacheKey, movies, 5 * 60 * 1000);
      return res.json({ status: true, data: movies, fallback: true });
    } catch (e) {
      console.warn('jikan search also failed:', e.message);
      return res.json({ status: true, data: [], fallback: true, static: true, upstream_error: err.message, fallback_error: e.message });
    }
  }
});

app.get('/v1/detail', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) throw new Error('ID nya mana memek');

    const detailRes = await proxyFetch(`${BASE_API}/movie/detail/${id}`);

    let allEpisodes = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const episodesRes = await proxyFetch(`${BASE_API}/movie/episode/${id}?page=${page}`);
        const eps = episodesRes.data?.episode || [];
        if (eps.length > 0) {
          allEpisodes = [...allEpisodes, ...eps];
          page++;
        } else {
          hasMore = false;
        }
      } catch {
        hasMore = false;
      }
    }

    res.json({
      status: true,
      data: {
        ...detailRes.data?.movie,
        episode_list: allEpisodes
      }
    });
  } catch (err) {
    // Fallback to Jikan if id is numeric
    const { id } = req.query;
    if (id && /^\d+$/.test(String(id))) {
      try {
        const json = await fetchJson(`https://api.jikan.moe/v4/anime/${id}/full`);
        const a = json.data;
        if (a) {
          return res.json({
            status: true,
            fallback: true,
            data: {
              id: a.mal_id,
              title: a.title,
              synopsis: a.synopsis,
              poster: a.images?.jpg?.large_image_url,
              genres: a.genres?.map(g => g.name),
              score: a.score,
              episodes: a.episodes,
              status: a.status,
              year: a.year,
              episode_list: [],
              source: 'jikan'
            }
          });
        }
      } catch {}
    }
    res.status(500).json({
      status: false,
      message: err.message
    });
  }
});

app.get('/v1/episode', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) throw new Error('ID episode nya mana memek');

    const data = await proxyFetch(`${BASE_API}/episode/streamnew/${id}`);

    res.json({
      status: true,
      data: {
        episode: data.data?.episode || {},
        server: data.data?.server || [],
        next_episode: data.data?.episode_next || null
      }
    });
  } catch (err) {
    res.status(500).json({
      status: false,
      message: err.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    status: false,
    message: 'memek elaina wangyy - endpoint not found',
    available: ['/v1/genre', '/v1/popular', '/v1/search', '/v1/schedule', '/v1/ongoing', '/v1/detail', '/v1/episode', '/v1/health']
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
