import express from 'express';
import dotenv from 'dotenv';
import { fetchJson } from './cf.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BASE_API = (process.env.BASE_API || 'https://api.jikan.moe/v4').replace(/\/+$/, '');
const SCHEDULE_DAYS = ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU', 'RANDOM'];

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function jikanUrl(path, params = {}) {
  const url = new URL(path.replace(/^\/+/, ''), `${BASE_API}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function jikanPage(legacyPage = 0) {
  const page = Number(legacyPage);
  return Number.isSafeInteger(page) && page >= 0 ? page + 1 : 1;
}

function parseAnimeId(value) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) return null;
  return Number(id);
}

// Cache keeps popular, genre, and schedule reads from consuming Jikan's quota.
const cache = new Map();
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function jikanToMovie(anime) {
  const animeStatus = String(anime.status || '').toLowerCase();
  return {
    id: anime.mal_id == null ? '' : String(anime.mal_id),
    mal_id: anime.mal_id,
    title: anime.title,
    title_english: anime.title_english,
    title_japanese: anime.title_japanese,
    poster: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url,
    image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url,
    type: anime.type,
    status: animeStatus.includes('finished') || animeStatus.includes('completed') ? 'COMPLETED' : 'ONGOING',
    score: anime.score,
    synopsis: anime.synopsis,
    year: anime.year || anime.aired?.prop?.from?.year,
    genres: (anime.genres || []).map(genre => genre.name),
    genre_ids: (anime.genres || []).map(genre => genre.mal_id),
    episodes: anime.episodes,
    aired: anime.aired,
    source: 'jikan'
  };
}

async function jikanSearch(query, page = 0) {
  const q = String(query || '').trim();
  if (!q) return [];
  const json = await fetchJson(jikanUrl('anime', {
    q,
    page: jikanPage(page),
    sfw: 'true',
    order_by: 'popularity',
    sort: 'desc'
  }));
  return (Array.isArray(json.data) ? json.data : []).map(jikanToMovie);
}

async function jikanPopular(page = 0) {
  const json = await fetchJson(jikanUrl('top/anime', {
    page: jikanPage(page),
    sfw: 'true'
  }));
  return (Array.isArray(json.data) ? json.data : []).map(jikanToMovie);
}

async function jikanByGenre(genreId, page = 0) {
  const requestedIds = Array.isArray(genreId) ? genreId : String(genreId ?? '').split(',');
  const ids = requestedIds
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(value => /^\d+$/.test(value));
  if (!ids.length) throw new Error('Genre id must be a numeric Jikan genre id');

  const json = await fetchJson(jikanUrl('anime', {
    genres: ids.join(','),
    page: jikanPage(page),
    order_by: 'popularity',
    sort: 'desc',
    sfw: 'true'
  }));
  return (Array.isArray(json.data) ? json.data : []).map(jikanToMovie);
}

async function jikanSchedule(day) {
  const dayFilters = {
    SENIN: 'monday',
    SELASA: 'tuesday',
    RABU: 'wednesday',
    KAMIS: 'thursday',
    JUMAT: 'friday',
    SABTU: 'saturday',
    MINGGU: 'sunday'
  };
  const normalizedDay = String(day || '').toUpperCase();

  if (normalizedDay === 'RANDOM') {
    const json = await fetchJson(jikanUrl('random/anime', { sfw: 'true' }));
    return json.data ? [jikanToMovie(json.data)] : [];
  }

  const params = { sfw: 'true' };
  if (dayFilters[normalizedDay]) params.filter = dayFilters[normalizedDay];
  const json = await fetchJson(jikanUrl('schedules', params));
  return (Array.isArray(json.data) ? json.data : []).map(jikanToMovie).slice(0, 25);
}

function jikanGenreGroup(genre) {
  const name = String(genre.name || '');
  if (['Shounen', 'Shoujo', 'Seinen', 'Josei', 'Kids'].includes(name)) return 'Demographic';
  if (['Ecchi', 'Hentai', 'Erotica'].includes(name)) return 'Explicit';
  return 'Genre';
}

function sendUpstreamFailure(res, error) {
  return res.json({ status: true, data: [], error: error.message });
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
      '/v1/detail?id=20',
      '/v1/episode?id=20',
      '/v1/health'
    ]
  });
});

app.get('/v1/health', async (req, res) => {
  const checks = {};
  try {
    const json = await fetchJson(jikanUrl('genres/anime'));
    const count = Array.isArray(json.data) ? json.data.length : 0;
    checks.upstream = { ok: true, genre_count: count, keys: Object.keys(json).slice(0, 5) };
    checks.jikan = { ok: true, count };
  } catch (error) {
    checks.upstream = { ok: false, error: error.message, status: error.statusCode || null };
    checks.jikan = { ok: false, error: error.message };
  }

  res.json({
    status: true,
    base_api: BASE_API,
    cf_proxy: '',
    checks,
    fallback_genres_count: 0
  });
});

app.get('/v1/schedule', async (req, res) => {
  const cacheKey = 'schedule';
  const cached = getCache(cacheKey);
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  const scheduleData = Object.fromEntries(SCHEDULE_DAYS.map(day => [day, []]));
  const errors = [];
  await Promise.all(SCHEDULE_DAYS.map(async day => {
    try {
      scheduleData[day] = await jikanSchedule(day);
    } catch (error) {
      errors.push(error);
      console.warn(`Jikan schedule request failed for ${day}:`, error.message);
    }
  }));

  setCache(cacheKey, scheduleData, errors.length ? 30_000 : 5 * 60 * 1000);
  return res.json({ status: true, data: scheduleData });
});

app.get('/v1/ongoing', async (req, res) => {
  const cacheKey = 'ongoing';
  const cached = getCache(cacheKey);
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  try {
    const json = await fetchJson(jikanUrl('seasons/now', { sfw: 'true', filter: 'tv' }));
    const list = (Array.isArray(json.data) ? json.data : [])
      .map(jikanToMovie)
      .filter(movie => movie.status === 'ONGOING');
    setCache(cacheKey, list, 5 * 60 * 1000);
    return res.json({ status: true, data: list });
  } catch (error) {
    console.warn('Jikan ongoing request failed:', error.message);
    return sendUpstreamFailure(res, error);
  }
});

app.get('/v1/genre', async (req, res) => {
  const { id, page = 0 } = req.query;
  const hasGenreFilter = id !== undefined && String(id).trim() !== '';

  if (hasGenreFilter) {
    const ids = Array.isArray(id) ? id.join(',') : String(id);
    const cacheKey = `genre_${ids}_${page}`;
    const cached = getCache(cacheKey);
    if (cached !== null) return res.json({ status: true, data: cached, cached: true });

    try {
      const movies = await jikanByGenre(id, page);
      setCache(cacheKey, movies, 5 * 60 * 1000);
      return res.json({ status: true, data: movies });
    } catch (error) {
      console.warn(`Jikan genre request failed for id=${ids}:`, error.message);
      return sendUpstreamFailure(res, error);
    }
  }

  const cached = getCache('genre_list');
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  try {
    const json = await fetchJson(jikanUrl('genres/anime'));
    const genres = (Array.isArray(json.data) ? json.data : []).map(genre => ({
      id: genre.mal_id,
      name: genre.name,
      group: jikanGenreGroup(genre)
    }));
    setCache('genre_list', genres, 30 * 60 * 1000);
    return res.json({ status: true, data: genres });
  } catch (error) {
    console.warn('Jikan genre list request failed:', error.message);
    return sendUpstreamFailure(res, error);
  }
});

app.get('/v1/popular', async (req, res) => {
  const { page = 0 } = req.query;
  const cacheKey = `popular_${page}`;
  const cached = getCache(cacheKey);
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  try {
    const movies = await jikanPopular(page);
    setCache(cacheKey, movies, 5 * 60 * 1000);
    return res.json({ status: true, data: movies });
  } catch (error) {
    console.warn('Jikan popular request failed:', error.message);
    return sendUpstreamFailure(res, error);
  }
});

app.get('/v1/search', async (req, res) => {
  const { q = '', page = 0 } = req.query;
  const query = String(q).trim();
  if (!query) return res.json({ status: true, data: [] });

  const cacheKey = `search_${query}_${page}`;
  const cached = getCache(cacheKey);
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  try {
    const movies = await jikanSearch(query, page);
    setCache(cacheKey, movies, 5 * 60 * 1000);
    return res.json({ status: true, data: movies });
  } catch (error) {
    console.warn('Jikan search request failed:', error.message);
    return sendUpstreamFailure(res, error);
  }
});

app.get('/v1/detail', async (req, res) => {
  const id = parseAnimeId(req.query.id);
  if (id === null) {
    return res.status(400).json({ status: false, message: 'A numeric Jikan anime id is required' });
  }

  const cacheKey = `detail_${id}`;
  const cached = getCache(cacheKey);
  if (cached !== null) return res.json({ status: true, data: cached, cached: true });

  try {
    const [detailResult, episodesResult] = await Promise.allSettled([
      fetchJson(jikanUrl(`anime/${id}/full`)),
      fetchJson(jikanUrl(`anime/${id}/episodes`, { page: 1 }))
    ]);

    if (detailResult.status === 'rejected') throw detailResult.reason;
    const anime = detailResult.value.data;
    if (!anime) throw new Error('Jikan returned no anime detail');

    let episodeList = [];
    if (episodesResult.status === 'fulfilled') {
      episodeList = Array.isArray(episodesResult.value.data)
        ? episodesResult.value.data.map(episode => ({ ...episode, id: episode.mal_id }))
        : [];
    } else {
      console.warn(`Jikan episode list request failed for anime ${id}:`, episodesResult.reason.message);
    }

    const detail = {
      ...jikanToMovie(anime),
      id: anime.mal_id,
      status: anime.status,
      episode_list: episodeList,
      trailer: anime.trailer || null,
      url: anime.url
    };
    setCache(cacheKey, detail, 10 * 60 * 1000);
    return res.json({ status: true, data: detail });
  } catch (error) {
    console.warn(`Jikan detail request failed for anime ${id}:`, error.message);
    return res.status(error.statusCode === 404 ? 404 : 502).json({ status: false, message: error.message });
  }
});

app.get('/v1/episode', async (req, res) => {
  const id = parseAnimeId(req.query.id);
  if (id === null) {
    return res.status(400).json({ status: false, message: 'A numeric Jikan anime id is required' });
  }

  try {
    const json = await fetchJson(jikanUrl(`anime/${id}/full`));
    const anime = json.data;
    if (!anime) throw new Error('Jikan returned no anime detail');

    const youtubeId = anime.trailer?.youtube_id || null;
    const encodedYoutubeId = youtubeId ? encodeURIComponent(youtubeId) : null;
    const watchUrl = encodedYoutubeId ? `https://www.youtube.com/watch?v=${encodedYoutubeId}` : null;
    const embedUrl = encodedYoutubeId ? `https://www.youtube.com/embed/${encodedYoutubeId}` : null;

    return res.json({
      status: true,
      data: {
        episode: {
          id: anime.mal_id,
          title: anime.title,
          title_english: anime.title_english,
          youtube_id: youtubeId,
          trailer: youtubeId ? { youtube_id: youtubeId, url: watchUrl, embed_url: embedUrl } : null
        },
        server: youtubeId ? [{
          name: 'YouTube',
          server: 'YouTube',
          url: embedUrl,
          link: watchUrl,
          embed_url: embedUrl,
          youtube_id: youtubeId,
          type: 'trailer'
        }] : [],
        next_episode: null
      }
    });
  } catch (error) {
    console.warn(`Jikan trailer request failed for anime ${id}:`, error.message);
    return res.status(error.statusCode === 404 ? 404 : 502).json({ status: false, message: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    status: false,
    message: 'Endpoint not found',
    available: ['/v1/genre', '/v1/popular', '/v1/search', '/v1/schedule', '/v1/ongoing', '/v1/detail', '/v1/episode', '/v1/health']
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
