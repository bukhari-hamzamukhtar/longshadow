import { DAY, HOUR } from "./windows";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtUTC(t: number, sec = false): string {
  const d = new Date(t);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, sec ? 19 : 16) + " UTC";
}

export function fmtDay(t: number, year = false): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? " " + d.getUTCFullYear() : ""}`;
}

export function fmtDayTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

export function fmtDur(ms: number): string {
  const a = Math.abs(ms);
  if (a >= 2 * DAY) {
    const d = Math.floor(a / DAY), h = Math.round((a - d * DAY) / HOUR);
    return h === 24 ? `${d + 1} d` : h ? `${d} d ${h} h` : `${d} d`;
  }
  if (a >= HOUR) {
    const h = Math.floor(a / HOUR), m = Math.round((a - h * HOUR) / 60e3);
    return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.max(1, Math.round(a / 60e3))} min`;
}

export function fmtHours(h: number): string {
  if (h >= 48) return `${(h / 24).toFixed(1)} d`;
  if (h >= 10) return `${Math.round(h)} h`;
  return `${h.toFixed(1)} h`;
}

export const deg = (v: number, d = 2) => `${v.toFixed(d)}°`;
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

export function toInputValue(t: number): string {
  return new Date(t).toISOString().slice(0, 16);
}
export function fromInputValue(v: string): number {
  return Date.parse(v + ":00Z");
}

const CARD = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass(az: number): string {
  return CARD[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
