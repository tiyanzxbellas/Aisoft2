# Aisoft2 API

Express REST API yang mempertahankan rute `/v1/*` untuk frontend dan mengambil data anime langsung dari Jikan API v4. Request upstream dikirim langsung ke `BASE_API`; aplikasi tidak menggunakan worker atau layanan proxy. `CF_PROXY` dipertahankan sebagai variabel kompatibilitas, tetapi dikosongkan dan tidak dipakai.

## Menjalankan lokal

```bash
npm install
cp .env.example .env
npm start
```

Konfigurasi default:

```env
BASE_API=https://api.jikan.moe/v4
CF_PROXY=
PORT=3000
```

Tambahkan variabel yang sama pada konfigurasi environment deployment. Jangan menambahkan secret proxy.

## Endpoint

Semua endpoint data menggunakan envelope `{ "status": true, "data": ... }` saat berhasil.

- `GET /v1/health` — cek akses Jikan.
- `GET /v1/genre` — daftar genre anime.
- `GET /v1/genre?id=14&page=0` — anime berdasarkan MAL genre ID.
- `GET /v1/popular?page=0` — anime populer.
- `GET /v1/search?q=naruto&page=0` — pencarian anime.
- `GET /v1/schedule` — jadwal untuk Senin–Minggu dan daftar acak.
- `GET /v1/ongoing` — anime yang sedang tayang pada musim sekarang.
- `GET /v1/detail?id=20` — detail anime dan daftar episode halaman pertama.
- `GET /v1/episode?id=20` — metadata trailer YouTube anime; Jikan tidak menyediakan video episode atau MP4.

Parameter `page` untuk frontend dimulai dari `0`; API mengubahnya menjadi halaman Jikan yang dimulai dari `1`. Respons koleksi menggunakan model movie yang konsisten (`id`, `title`, `poster`, `genres`, `score`, dan field terkait). Jadwal mempertahankan key hari berhuruf kapital yang digunakan frontend lama.

`/v1/episode` menerima MAL anime ID. Bila Jikan menyediakan `trailer.youtube_id`, respons menyertakan URL tonton dan embed YouTube pada struktur `data.episode` / `data.server`; bila trailer tidak tersedia, `server` berupa array kosong. Endpoint ini tidak mem-proxy atau mengembalikan stream video.

## Deploy ke Vercel

Import repository ini ke Vercel lalu deploy. `vercel.json` meneruskan semua path ke `api/index.js`, yang menggunakan Express app yang sama dengan mode lokal. Atur `BASE_API=https://api.jikan.moe/v4` dan `PORT` bila diperlukan. Biarkan `CF_PROXY` kosong.
