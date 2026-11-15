// The app can be served from the domain root (Vercel) or from a sub-folder (GitHub Pages).
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" or "/longshadow"
export const DATA = `${BASE}/data`;
export const MEDIA = `${BASE}/media`;
