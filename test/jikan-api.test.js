import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const anime = {
  mal_id: 20,
  title: 'Naruto',
  title_english: 'Naruto',
  title_japanese: 'ナルト',
  images: { jpg: { large_image_url: 'https://images.example/naruto.jpg' } },
  type: 'TV',
  status: 'Currently Airing',
  score: 8.1,
  synopsis: 'A ninja story.',
  year: 2002,
  episodes: 220,
  genres: [{ mal_id: 1, name: 'Action' }],
  aired: { prop: { from: { year: 2002 } } },
  trailer: { youtube_id: 'abc123xyz01' },
  url: 'https://myanimelist.net/anime/20/Naruto'
};

const requests = [];
let jikanServer;
let appServer;
let apiOrigin;

function respond(res, body, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  jikanServer = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requests.push(url);

    if (url.pathname === '/v4/genres/anime') {
      return respond(res, { data: [{ mal_id: 1, name: 'Action' }] });
    }
    if (url.pathname === '/v4/top/anime') {
      return respond(res, { data: [anime] });
    }
    if (url.pathname === '/v4/anime' || url.pathname === '/v4/anime/') {
      return respond(res, { data: [anime] });
    }
    if (url.pathname === '/v4/schedules') {
      return respond(res, { data: [anime] });
    }
    if (url.pathname === '/v4/random/anime') {
      return respond(res, { data: anime });
    }
    if (url.pathname === '/v4/seasons/now') {
      return respond(res, { data: [anime] });
    }
    if (url.pathname === '/v4/anime/20/full') {
      return respond(res, { data: anime });
    }
    if (url.pathname === '/v4/anime/20/episodes') {
      return respond(res, { data: [{ mal_id: 1, title: 'Enter: Naruto Uzumaki!' }] });
    }
    return respond(res, { message: `Unexpected upstream route: ${url.pathname}` }, 404);
  });
  jikanServer.listen(0, '127.0.0.1');
  await new Promise(resolve => jikanServer.once('listening', resolve));
  const upstreamPort = jikanServer.address().port;

  process.env.BASE_API = `http://127.0.0.1:${upstreamPort}/v4`;
  process.env.VERCEL = '1';
  const { default: app } = await import('../server.js');
  appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  apiOrigin = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  for (const server of [appServer, jikanServer]) {
    if (!server?.listening) continue;
    await new Promise(resolve => server.close(resolve));
  }
});

test('legacy v1 routes are backed directly by Jikan and keep their response envelope', async () => {
  const healthResponse = await fetch(`${apiOrigin}/v1/health`);
  const health = await healthResponse.json();
  assert.equal(health.status, true);
  assert.equal(health.cf_proxy, '');
  assert.equal(health.checks.jikan.ok, true);

  const genres = await (await fetch(`${apiOrigin}/v1/genre`)).json();
  assert.deepEqual(genres.data, [{ id: 1, name: 'Action', group: 'Genre' }]);

  const byGenre = await (await fetch(`${apiOrigin}/v1/genre?id=14&page=0`)).json();
  assert.equal(byGenre.status, true);
  assert.equal(byGenre.data[0].id, '20');

  const popular = await (await fetch(`${apiOrigin}/v1/popular?page=0`)).json();
  assert.equal(popular.status, true);
  assert.equal(popular.data[0].title, 'Naruto');

  const search = await (await fetch(`${apiOrigin}/v1/search?q=naruto&page=0`)).json();
  assert.equal(search.status, true);
  assert.equal(search.data[0].poster, 'https://images.example/naruto.jpg');

  const schedule = await (await fetch(`${apiOrigin}/v1/schedule`)).json();
  assert.deepEqual(Object.keys(schedule.data), ['SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU', 'MINGGU', 'RANDOM']);
  assert.equal(schedule.data.SENIN[0].title, 'Naruto');
  assert.equal(schedule.data.RANDOM[0].title, 'Naruto');

  const ongoing = await (await fetch(`${apiOrigin}/v1/ongoing`)).json();
  assert.equal(ongoing.status, true);
  assert.equal(ongoing.data[0].status, 'ONGOING');

  const detail = await (await fetch(`${apiOrigin}/v1/detail?id=20`)).json();
  assert.equal(detail.status, true);
  assert.equal(detail.data.id, 20);
  assert.equal(detail.data.episode_list[0].title, 'Enter: Naruto Uzumaki!');

  const episode = await (await fetch(`${apiOrigin}/v1/episode?id=20`)).json();
  assert.equal(episode.status, true);
  assert.equal(episode.data.episode.youtube_id, 'abc123xyz01');
  assert.equal(episode.data.server[0].type, 'trailer');
  assert.equal(episode.data.next_episode, null);

  const popularRequest = requests.find(url => url.pathname === '/v4/top/anime');
  const genreRequest = requests.find(url => url.pathname === '/v4/anime' && url.searchParams.has('genres'));
  const searchRequest = requests.find(url => url.pathname === '/v4/anime' && url.searchParams.has('q'));
  const scheduleRequest = requests.find(url => url.pathname === '/v4/schedules');
  const ongoingRequest = requests.find(url => url.pathname === '/v4/seasons/now');
  const episodeListRequest = requests.find(url => url.pathname === '/v4/anime/20/episodes');

  assert.equal(popularRequest.searchParams.get('page'), '1');
  assert.equal(genreRequest.searchParams.get('page'), '1');
  assert.equal(genreRequest.searchParams.get('genres'), '14');
  assert.equal(searchRequest.searchParams.get('page'), '1');
  assert.equal(searchRequest.searchParams.get('q'), 'naruto');
  assert.equal(scheduleRequest.searchParams.get('filter'), 'monday');
  assert.equal(ongoingRequest.searchParams.get('filter'), 'tv');
  assert.equal(episodeListRequest.searchParams.get('page'), '1');
  assert.ok(requests.every(url => url.origin === `http://127.0.0.1:${jikanServer.address().port}`));
});
