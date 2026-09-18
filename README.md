# nefusoft-api

API Express yang dapat dijalankan lokal maupun dideploy ke Vercel.

Semua request ke upstream **wajib** lewat `cf.js` (`proxyFetch` / `proxyStream`). File itu yang memasang header browser, `X-Proxy-Secret`, dan — kalau target di belakang Cloudflare — meneruskan request lewat CORS worker.

## Kenapa 403 "Just a moment..."?

`xyz-api.animein.net` diproteksi Cloudflare JS challenge. Request langsung dari IP datacenter (Vercel, dll) kena halaman *Just a moment...*. Header saja tidak cukup.

`cf.js` menangani ini dengan urutan:

1. Header dari `cf.js` (UA pool, `Origin`, `Referer`, `X-Proxy-Secret`, Sec-CH, ...)
2. Untuk host `*.animein.net` / `*.animeinweb.com`, request **pertama** lewat CORS proxy:
   `https://cf.tiyanstores.workers.dev/?url=<URL_TARGET>`
3. Kalau worker gagal, baru coba langsung ke target

Worker harus dideploy dari `worker.js` (atau disamakan dengan file itu). Set secret `PROXY_SECRET` di Cloudflare Worker dengan nilai yang sama seperti environment variable `PROXY_SECRET` di Vercel. Worker hanya meneruskan request; CORS tidak bisa melewati JavaScript challenge Cloudflare.

Jika masih mendapat `Cloudflare challenge (Just a moment...) [status 403]`, masalahnya ada di rule Cloudflare pada origin `xyz-api.animein.net`, bukan di CORS API. Buat rule WAF/Managed Challenge **Skip** untuk route API (misalnya `/3/2/*`) atau allowlist request dari Worker, lalu purge/deploy ulang rule tersebut. Jangan mencoba menyelesaikannya dengan mengganti User-Agent saja.

## Deploy ke Vercel

1. Import repository ini ke Vercel, atau jalankan `vercel` dari root proyek.
2. Tambahkan Environment Variable di **Project Settings → Environment Variables**:

   ```text
   BASE_API=https://xyz-api.animein.net/3/2
   CF_PROXY=https://cf.tiyanstores.workers.dev/
   ```

   `CF_PROXY` opsional — default-nya sudah worker di atas. Jangan pakai `https://animeinweb.com/api/proxy/3/2` sebagai `BASE_API` (403: Direct API Proxy access is blocked).

3. Deploy.

`vercel.json` me-rewrite semua path ke `api/index.js` → `server.js`. Setiap route `/v1/*` memanggil `proxyFetch` / `proxyStream` dari `cf.js`.

## Lokal

```bash
npm install
npm start
```

Buat `.env`:

```text
BASE_API=https://xyz-api.animein.net/3/2
CF_PROXY=https://cf.tiyanstores.workers.dev/
PORT=3000
```

## CORS video

Pemutaran file di `storages.animein.net` juga lewat worker yang sama:

```
https://cf.tiyanstores.workers.dev/?url=<URL_VIDEO>
```

Atau lewat endpoint API:

```
/v1/proxy?url=<URL_VIDEO>
```

## Endpoint

- `/v1/schedule`
- `/v1/genre`
- `/v1/genre?id=`
- `/v1/ongoing?page=`
- `/v1/popular?page=`
- `/v1/detail?id=`
- `/v1/episode?id=`
- `/v1/search?q=`
- `/v1/health`

## Catatan

- Jangan menyimpan token atau secret deployment di `.env` yang dikomit. Konfigurasi environment production harus disimpan di dashboard Vercel.
- Endpoint `/v1/proxy` meneruskan stream respons upstream. Batas durasi function pada `vercel.json` adalah 60 detik; video atau download panjang dapat terhenti karena batas platform Vercel.
