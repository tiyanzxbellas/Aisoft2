# Aisoft2 API — v2.0.0

[![CI](https://github.com/tiyanzxbellas/Aisoft2-/actions/workflows/ci.yml/badge.svg)](https://github.com/tiyanzxbellas/Aisoft2-/actions/workflows/ci.yml)

REST API anime berbahasa Indonesia. Sumber utama **animein** (`xyz-api.animein.net`),
cadangan otomatis **AniList** (GraphQL, tanpa API key). Jalan lokal di Termux/Node
18+ maupun dideploy ke Vercel.

Semua endpoint sudah **terverifikasi hidup** (25/25 smoke test lolos, lihat `npm test`).

**Base URL production**

| URL | Keterangan |
|---|---|
| `https://apisoft.tiyan.my.id` | domain utama (custom, SSL otomatis) |
| `https://www.apisoft.tiyan.my.id` | redirect 308 ke domain utama |
| `https://aisoft2-api.vercel.app` | alias Vercel (tetap aktif) |

```bash
curl https://apisoft.tiyan.my.id/v1/health
curl "https://apisoft.tiyan.my.id/v1/search?q=frieren"
```

---

## Akar masalah 403 "Just a moment..." (dan solusinya)

Versi sebelumnya selalu balik 403 dari upstream. Setelah diuji sistematis, penyebabnya
**bukan header**:

| Transport | Hasil ke `xyz-api.animein.net` |
|---|---|
| `curl` (OpenSSL/HTTP2 milik curl) | **200 OK** (12/12 request stabil) |
| `undici` / `node:https` / `fetch` bawaan Node | **403** halaman Cloudflare, walau header 100% identik |
| CORS worker `cf.tiyanstores.workers.dev` | 403 (`Attention Required` — worker-nya diblokir origin) |
| proxy publik (allorigins, codetabs, corsproxy, jina) | 403 / 522 / butuh key |

Artinya Cloudflare memfilter **fingerprint TLS/HTTP2** (JA3/JA4), bukan `User-Agent`.
Node dengan OpenSSL bawaan punya fingerprint yang langsung dicap bot.

Solusi yang dipakai: **`cf.js` jadi transport berlapis**

1. **curl** (utama) — `execFile`/`spawn` dengan argumen array (tanpa shell, aman dari injection).
2. **undici** (cadangan) — dipakai kalau binary `curl` tidak tersedia / `USE_CURL=0`.
3. Ring buffer cache + *stale fallback*, lalu **AniList** sebagai sumber pengganti
   kalau upstream benar-benar tidak bisa dihubungi.

Header yang memang dibutuhkan (sudah otomatis):

| Target | Header wajib |
|---|---|
| API (`/3/2/...`) | `User-Agent` browser (tanpa-UA = 403) |
| Asset gambar (`/assets*/`) | `User-Agent` **+ `Referer: https://animeinweb.com/`** |
| Video (`storages.animein.net`) | `User-Agent`, mendukung `Range` (206) |
| AniList | biasa (tidak ada proteksi) |

---

## Endpoint

| Endpoint | Keterangan |
|---|---|
| `GET /` | info + daftar endpoint |
| `GET /v1/health` | status transport (curl/undici), upstream, AniList, latency |
| `GET /v1/genre` | 33 genre + ikon (URL sudah diproksi) |
| `GET /v1/genre?id=14&page=0` | daftar anime per genre (boleh `id=14,16`) |
| `GET /v1/popular?page=0` | populer (urut views) |
| `GET /v1/search?q=naruto&page=0` | pencarian |
| `GET /v1/schedule` | jadwal 7 hari (`SENIN`..`MINGGU`) |
| `GET /v1/schedule?day=SENIN` | jadwal satu hari (lebih ringan) |
| `GET /v1/ongoing` | semua anime `ONGOING` (dedup dari jadwal) |
| `GET /v1/detail?id=426&pages=3` | detail + `episode_list` (30 episode/halaman upstream) |
| `GET /v1/episodes?id=426&page=1` | episode per halaman |
| `GET /v1/episode?id=321196` | link streaming 360p/480p/720p/1080p + `play_url` |
| `GET /v1/proxy?url=<encoded>` | 302 ke CDN (default) — hemat bandwidth |
| `GET /v1/proxy?url=<encoded>&stream=1` | server yang streaming (mendukung `Range`) |
| `GET /v1/img?url=<encoded>` | proxy gambar (menambahkan `Referer` yang diminta upstream) |

Semua respons lama tetap sama bentuknya (`{ status, data }`), jadi client lama tidak pecah.
Tambahan field: `total`, `page`, `fallback`, `source`, `stale`, `upstream_error`.

### Contoh

```bash
curl "http://127.0.0.1:3000/v1/popular?page=0"
curl "http://127.0.0.1:3000/v1/search?q=frieren"
curl "http://127.0.0.1:3000/v1/detail?id=426&pages=2"
curl "http://127.0.0.1:3000/v1/episode?id=321196"
```

```jsonc
// GET /v1/episode?id=321196
{
  "status": true,
  "data": {
    "episode": { "id": "321196", "index": 1180, "title": "Episode 1180", "image": ".../v1/img?url=..." },
    "server": [
      {
        "quality": "360p",
        "link": "https://storages.animein.net/One%20Piece%2F1180-360p-...mp4",
        "play_url": "http://host/v1/proxy?url=https%3A%2F%2Fstorages...",
        "stream_url": "http://host/v1/proxy?url=...&stream=1"
      }
    ],
    "next_episode": null
  }
}
```

**Cara main yang disarankan di client:**

* Poster/ikon → pakai `image_poster` / `image_cover` (sudah menunjuk ke `/v1/img`).
  Kalau butuh URL asli, set `IMG_MODE=source` atau `direct`.
* Video → pakai `play_url` di `<video src>`. Itu 302 ke CDN, jadi player memakai
  `Range` langsung dari CDN (seek mulus, bandwidth server 0).
  Kalau butuh lewat server (misal CDN diblokir jaringan tertentu) → `stream_url`.

### Header diagnostik

Setiap respons `/v1/*` menambahkan:

* `X-Data-Source` — `upstream` / `anilist` / `static` / `empty` / `error`
* `X-Cache` — `HIT` / `MISS` / `STALE`
* `X-Fallback: 1` — data dari AniList
* `X-Upstream-Error` — pesan error upstream (URL-encoded)

---

## Jalan lokal

```bash
npm install
cp .env.example .env     # opsional, default sudah benar
npm start                # http://127.0.0.1:3000
npm test                 # smoke test 25 pemeriksaan
```

Di Termux:

```bash
pkg install nodejs curl -y
git clone https://github.com/tiyanzxbellas/Aisoft2-.git
cd Aisoft2- && npm install && npm start
```

> `curl` wajib ada kalau ingin data penuh dari upstream. Tanpa curl API tetap
> menyala dengan data AniList (ada penanda `fallback: true`).

---

## Deploy ke Vercel

Production: **https://apisoft.tiyan.my.id** (custom domain) — alias Vercel
**https://aisoft2-api.vercel.app** (project `aisoft2-api`, team
`tiyanpalestines-projects`).

Custom domain dikelola lewat Vercel (`tiyan.my.id` DNS-nya sudah pakai
nameserver Vercel), jadi SSL terbit otomatis. `www.apisoft.tiyan.my.id`
dipasang sebagai **redirect 308** ke domain utama. Kalau mau ganti domain:

```bash
# daftarkan domain ke project (Vercel CLI)
vercel domains add apisoft.tiyan.my.id
vercel alias set <deployment-url> apisoft.tiyan.my.id
```

Atau lewat API: `POST /v10/projects/{projectId}/domains` body
`{"name":"domain.kamu"}` (untuk redirect: tambahkan `redirect` +
`redirectStatusCode`).

Repo ini sudah **tersambung ke project Vercel** (`link: github tiyanzxbellas/Aisoft2-`,
production branch `main`). Artinya: **push ke `main` = deploy otomatis**, tidak perlu
langkah manual lagi.

Kalau mau deploy dari nol (fork / project baru):

1. Import repo ini ke Vercel (framework: **Other**, tidak perlu build command).
2. Environment Variables (opsional, default sudah aman):

   ```text
   BASE_API=https://xyz-api.animein.net/3/2
   USE_CURL=auto
   IMG_MODE=proxy
   PROXY_MODE=redirect
   ```

3. Deploy. `vercel.json` me-rewrite semua path ke `api/index.js` (Express app yang sama).
4. **Matikan Deployment Protection** (Settings → Deployment Protection → Vercel
   Authentication: *Disabled*), kalau tidak semua URL balik 302 ke `vercel.com/sso-api`.

Catatan platform:

* `maxDuration` 60 detik (batas Hobby). `/v1/proxy?stream=1` untuk file besar bisa
  terputus; untuk pemutaran video pakai mode `redirect` (default).
* Kalau runtime-nya tidak punya binary `curl`, otomatis pakai `undici` →
  upstream 403 → semua endpoint jatuh ke AniList (`fallback: true`).
  `/v1/health` bisa dipakai untuk mengecek kondisi ini.

---

## Environment variable

| Variable | Default | Fungsi |
|---|---|---|
| `BASE_API` | `https://xyz-api.animein.net/3/2` | base upstream animein |
| `PORT` | `3000` | port server lokal |
| `USE_CURL` | `auto` | `1` paksa curl, `0` paksa undici |
| `IMG_MODE` | `proxy` | `proxy` / `direct` / `source` (URL gambar) |
| `PROXY_MODE` | `redirect` | `redirect` (302) / `pipe` (stream lewat server) |
| `UPSTREAM_TIMEOUT_MS` | `15000` | timeout request upstream |
| `REFERER_SITE` | `https://animeinweb.com/` | Referer untuk host asset |
| `PUBLIC_ORIGIN` | – | paksa origin publik (kalau di belakang proxy) |
| `LOG` | – | `1` untuk log tiap request |

---

## Struktur

```text
.
├── server.js        # Express app + semua route
├── cf.js            # transport: curl -> undici, header per-jenis target, stream/proxy
├── api/index.js     # entry point Vercel -> server.js
├── lib/
│   ├── anilist.js   # fallback GraphQL AniList + normalisasi bentuk data
│   ├── cache.js     # TTL cache + stale fallback
│   └── images.js    # normalisasi URL asset + pembuat URL /v1/img
├── test.js          # smoke test end-to-end
├── vercel.json
├── package-lock.json # lockfile ikut di-commit (build reproducible)
├── .github/workflows/ci.yml  # CI: sintaks + boot + smoke lokal
├── LICENSE          # MIT
└── .env.example
```

---

## Catatan keamanan

* `.env` **tidak** ikut di-commit (ada di `.gitignore`). Simpan konfigurasi
  production di dashboard Vercel.
* Jangan pernah menaruh token/kunci di file yang di-commit; kalau terlanjur, revoke
  lalu ganti.
* `/v1/proxy` dan `/v1/img` hanya menerima host `*.animein.net` / `animeinweb.com`,
  jadi tidak bisa dipakai sebagai open proxy.
* Argumen `curl` disusun sebagai array (`execFile`/`spawn`), tidak lewat shell.

## Perubahan v2.0.0

* Transport `curl` lebih dulu — memperbaiki 403 Cloudflare di semua endpoint.
* Header per jenis target (API vs asset gambar vs video).
* `/v1/img` proxy gambar (asset animein wajib `Referer`).
* `/v1/proxy` dengan dukungan `Range`/206 + mode 302.
* `/v1/episodes`, `/v1/schedule?day=`, `/v1/detail?pages=` (paginasi aman, tidak
  lagi memutar 40 request untuk One Piece).
* Fallback AniList menggantikan Jikan (Jikan timeout 20–30 detik dari IP ini).
* Cache TTL + stale fallback, header diagnostik, `/v1/health` informatif.
* Endpoint debug `secret-test` dihapus; pesan error dibersihkan; `.env` keluar dari repo.
