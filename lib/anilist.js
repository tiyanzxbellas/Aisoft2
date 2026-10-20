// Fallback sumber data kalau upstream animein tidak bisa diakses sama sekali.
// AniList GraphQL: gratis, tanpa API key, cepat (<2 detik dari perangkat ini).
// Jikan/MAL sengaja TIDAK dipakai: dari IP ini selalu timeout 20-30 detik.
const ENDPOINT = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  coverImage { extraLarge large color }
  bannerImage
  format
  status
  episodes
  duration
  averageScore
  popularity
  favourites
  season
  seasonYear
  genres
  description(asHtml: false)
  startDate { year month day }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  siteUrl
`;

const QUERY = `query ($page: Int, $perPage: Int, $search: String, $sort: [MediaSort], $genre: String, $season: MediaSeason, $seasonYear: Int, $status: MediaStatus, $id: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(id: $id, search: $search, type: ANIME, sort: $sort, genre: $genre, season: $season, seasonYear: $seasonYear, status: $status, isAdult: false) {
      ${MEDIA_FIELDS}
    }
  }
}`;

async function gql(variables, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Aisoft2-API/2.0' },
      body: JSON.stringify({ query: QUERY, variables }),
      signal: ctrl.signal
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    const page = json?.data?.Page;
    if (!page) throw new Error('AniList: data kosong');
    return page;
  } finally {
    clearTimeout(timer);
  }
}

const STATUS_MAP = {
  RELEASING: 'ONGOING',
  FINISHED: 'COMPLETED',
  NOT_YET_RELEASED: 'UPCOMING',
  CANCELLED: 'CANCELLED',
  HIATUS: 'HIATUS'
};

const DAY_INDEX = ['MINGGU', 'SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU'];

export function normalizeMedia(m) {
  if (!m) return null;
  const next = m.nextAiringEpisode;
  const airingDay = next ? DAY_INDEX[new Date(next.airingAt * 1000).getDay()] : null;
  return {
    id: String(m.id),
    id_mal: m.idMal ?? null,
    title: m.title?.romaji || m.title?.english || m.title?.native || 'Untitled',
    title_english: m.title?.english || null,
    title_japanese: m.title?.native || null,
    synopsis: m.description ? String(m.description).replace(/<[^>]+>/g, '').trim() : null,
    image_poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
    image_cover: m.bannerImage || m.coverImage?.extraLarge || m.coverImage?.large || null,
    type: m.format || null,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    day: airingDay,
    status: STATUS_MAP[m.status] || m.status || null,
    views: null,
    favorites: m.favourites ?? null,
    studio: null,
    aired_start: m.startDate?.year ? `${m.startDate.year}-${String(m.startDate.month || 1).padStart(2, '0')}-${String(m.startDate.day || 1).padStart(2, '0')}` : null,
    genre: (m.genres || []).join(', '),
    genres: m.genres || [],
    score: m.averageScore ? m.averageScore / 10 : null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    popularity: m.popularity ?? null,
    next_episode: next ? { episode: next.episode, airing_at: next.airingAt, countdown: next.timeUntilAiring } : null,
    url: m.siteUrl || null,
    source: 'anilist'
  };
}

export async function alPage(variables, opts = {}) {
  const page = await gql({ page: 1, perPage: opts.perPage || 20, ...variables }, opts.timeout);
  return {
    list: (page.media || []).map(normalizeMedia).filter(Boolean),
    pageInfo: page.pageInfo || null
  };
}

export async function alPopular(page = 0, perPage = 20) {
  return alPage({ page: Math.max(1, Number(page) + 1), perPage, sort: ['POPULARITY_DESC'] });
}

export async function alTrending(perPage = 20) {
  return alPage({ page: 1, perPage, sort: ['TRENDING_DESC'] });
}

export async function alOngoing(perPage = 25) {
  return alPage({ page: 1, perPage, status: 'RELEASING', sort: ['POPULARITY_DESC'] });
}

export async function alSearch(q, page = 0, perPage = 20) {
  return alPage({ page: Math.max(1, Number(page) + 1), perPage, search: q, sort: ['SEARCH_MATCH'] });
}

export async function alByGenre(genre, page = 0, perPage = 20) {
  return alPage({ page: Math.max(1, Number(page) + 1), perPage, genre, sort: ['POPULARITY_DESC'] });
}

export async function alDetail(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) throw new Error('AniList butuh id numerik');
  const byId = await gql({ id: numeric, perPage: 1 });
  const media = (byId.media || [])[0];
  if (!media) throw new Error('AniList: anime tidak ditemukan');
  return normalizeMedia(media);
}

export async function alSchedule(day) {
  const wanted = day ? String(day).toUpperCase() : null;
  const page = await gql({ page: 1, perPage: 50, status: 'RELEASING', sort: ['POPULARITY_DESC'] });
  const all = (page.media || []).map(normalizeMedia).filter(Boolean);
  if (!wanted || wanted === 'RANDOM') return all;
  return all.filter(m => m.day === wanted);
}

export const ANILIST_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo',
  'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
  'Sports', 'Supernatural', 'Thriller'
];
