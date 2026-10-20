// Smoke test end-to-end: menyalakan server di port acak, lalu memanggil semua
// endpoint publik dan memeriksa bentuk datanya. Tidak butuh tool tambahan.
//   node test.js
import app from './server.js';

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function check(name, cond, detail) {
  record(name, Boolean(cond), cond ? detail : detail || 'kondisi tidak terpenuhi');
  return Boolean(cond);
}

const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

async function req(path, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 45000), ...opts });
  const ms = Date.now() - t0;
  return { res, ms, text: async () => res.text() };
}

async function json(path, opts) {
  const r = await req(path, opts);
  const body = await r.res.json().catch(() => null);
  return { ...r, body };
}

try {
  // 1. root
  {
    const { res, body, ms } = await json('/');
    check('GET /', res.status === 200 && body?.status === true, `${res.status} ${ms}ms`);
  }

  // 2. health
  {
    const { res, body, ms } = await json('/v1/health', { timeout: 30000 });
    const t = body?.transport?.kind;
    check('GET /v1/health', res.status === 200 && !!t, `transport=${t} upstream=${body?.checks?.upstream?.ok} ${ms}ms`);
  }

  // 3. genre list
  let genres = [];
  {
    const { res, body, ms } = await json('/v1/genre');
    genres = body?.data || [];
    check('GET /v1/genre', res.status === 200 && genres.length > 5, `${genres.length} genre ${ms}ms`);
    check('genre punya gambar ter-proxy', genres.slice(0, 3).every(g => !g.image || g.image.includes('/v1/img')), String(genres[0]?.image || '').slice(0, 60));
  }

  // 4. popular
  let popular = [];
  {
    const { res, body, ms } = await json('/v1/popular?page=0');
    popular = body?.data || [];
    check('GET /v1/popular', res.status === 200 && popular.length > 0, `${popular.length} item ${ms}ms`);
    check('field penting popular', popular.length > 0 && 'title' in popular[0] && 'image_poster' in popular[0] && 'status' in popular[0], 'title/image_poster/status');
    check('poster dinormalisasi (tanpa // ganda)', popular.every(m => !m.image_poster || !/\/\/assets/.test(m.image_poster)), popular[0]?.image_poster?.slice(0, 70));
  }

  // 5. search
  {
    const { res, body, ms } = await json('/v1/search?q=naruto&page=0');
    const list = body?.data || [];
    check('GET /v1/search?q=naruto', res.status === 200 && list.length > 0, `${list.length} hasil ${ms}ms`);
    check('judul hasil mengandung naruto', list.slice(0, 5).some(m => /naruto/i.test(m.title || '')), list[0]?.title);
  }

  // 6. schedule satu hari
  let firstDayItem = null;
  {
    const { res, body, ms } = await json('/v1/schedule?day=SENIN');
    const list = body?.data || [];
    firstDayItem = list[0] || null;
    check('GET /v1/schedule?day=SENIN', res.status === 200 && list.length > 0, `${list.length} item ${ms}ms`);
  }

  // 7. schedule semua hari
  {
    const { res, body, ms } = await json('/v1/schedule');
    const days = Object.keys(body?.data || {});
    check('GET /v1/schedule (semua hari)', res.status === 200 && days.length >= 7, `${days.length} hari, total ${body?.total} ${ms}ms`);
  }

  // 8. ongoing
  {
    const { res, body, ms } = await json('/v1/ongoing');
    const list = body?.data || [];
    check('GET /v1/ongoing', res.status === 200 && list.length > 0, `${list.length} ongoing ${ms}ms`);
  }

  // 9. detail (1 halaman episode)
  let movieId = popular[0]?.id || '426';
  let streamLink = null;
  {
    const { res, body, ms } = await json(`/v1/detail?id=${movieId}&pages=1`);
    const d = body?.data;
    check('GET /v1/detail', res.status === 200 && !!d?.title, `${d?.title} · ${d?.episode_count} eps ${ms}ms`);
    check('detail punya episode_list', Array.isArray(d?.episode_list) && d.episode_list.length > 0, `${d?.episode_list?.length} episode`);
    const ep = d?.episode_list?.[0];
    if (ep?.id) {
      const { res: r2, body: b2 } = await json(`/v1/episode?id=${ep.id}`);
      streamLink = b2?.data?.server?.[0]?.link || null;
      check('GET /v1/episode', r2.status === 200 && (b2?.data?.server?.length || 0) > 0, `${b2?.data?.server?.length} server · ${ms}ms`);
      check('server punya play_url', !!b2?.data?.server?.[0]?.play_url, String(b2?.data?.server?.[0]?.quality || ''));
    }
  }

  // 10. episodes paginasi
  {
    const { res, body } = await json(`/v1/episodes?id=${movieId}&page=0`);
    check('GET /v1/episodes', res.status === 200 && (body?.data?.length || 0) > 0, `${body?.data?.length} item`);
  }

  // 11. gambar ter-proxy
  const poster = popular[0]?.image_poster;
  if (check('poster tersedia', !!poster, String(poster).slice(0, 60))) {
    const r = await req(poster.replace(BASE, ''));
    const buf = Buffer.from(await r.res.arrayBuffer());
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    check('GET /v1/img (proxy gambar)', r.res.status === 200 && (isJpeg || isPng) && buf.length > 1000, `${r.res.status} ${buf.length}B ${r.res.headers.get('content-type')} ${r.ms}ms`);
  }

  // 12. proxy video: redirect
  if (check('link video tersedia', !!streamLink, String(streamLink).slice(0, 60))) {
    const enc = encodeURIComponent(streamLink);
    {
      const r = await req(`/v1/proxy?url=${enc}`);
      check('GET /v1/proxy (redirect)', r.res.status === 302 && !!r.res.headers.get('location'), `${r.res.status} ${r.ms}ms`);
    }
    {
      const r = await req(`/v1/proxy?url=${enc}&stream=1`, { headers: { Range: 'bytes=0-262143' } });
      const buf = Buffer.from(await r.res.arrayBuffer());
      const isMp4 = buf.slice(4, 8).toString() === 'ftyp';
      check('GET /v1/proxy?stream=1 (Range)', r.res.status === 206 && buf.length === 262144 && isMp4, `${r.res.status} ${buf.length}B ${r.res.headers.get('content-type')} ${r.ms}ms`);
    }
    {
      const r = await req(`/v1/proxy?url=${encodeURIComponent('https://example.com/a.mp4')}&stream=1`);
      await r.res.text();
      check('proxy menolak host asing', r.res.status === 403, `${r.res.status}`);
    }
  }

  // 13. 400 & 404
  {
    const r = await req('/v1/detail');
    await r.res.text();
    check('detail tanpa id -> 400', r.res.status === 400, `${r.res.status}`);
  }
  {
    const r = await req('/tidak-ada');
    await r.res.text();
    check('endpoint tidak dikenal -> 404', r.res.status === 404, `${r.res.status}`);
  }
} catch (e) {
  record('runner', false, e.message);
} finally {
  server.close();
}

const total = results.length;
console.log(`\n${failures === 0 ? 'ALL_OK' : 'ADA_GAGAL'} — ${total - failures}/${total} lolos`);
process.exit(failures === 0 ? 0 : 1);
