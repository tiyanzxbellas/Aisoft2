// Cache TTL kecil dengan "stale fallback": kalau upstream mati, data terakhir
// yang masih bagus tetap dipakai (dengan penanda stale) alih-alih balik kosong.
export class TtlCache {
  constructor(maxEntries = 400) {
    this.map = new Map();
    this.max = maxEntries;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) return null;
    return e.data;
  }

  has(key) {
    return this.get(key) !== null;
  }

  stale(key, maxAgeMs = 24 * 60 * 60 * 1000) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.storedAt > maxAgeMs) return null;
    return e.data;
  }

  set(key, data, ttlMs) {
    this.map.set(key, { data, exp: Date.now() + ttlMs, storedAt: Date.now() });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return data;
  }

  del(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

export const ttl = {
  seconds: s => s * 1000,
  minutes: m => m * 60 * 1000,
  hours: h => h * 60 * 60 * 1000
};
