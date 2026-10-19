// Entry point Vercel. Seluruh route diteruskan ke Express app yang sama
// dengan mode lokal; setiap request keluar ke upstream tetap memakai cf.js.
import app from '../server.js';

export default app;
