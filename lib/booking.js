// lib/booking.js — appointment booking for generated sites (LeadStack-gap phase 2).
//
// Pure slot logic + validation over injected state, mirroring lib/sequences.js's shape so the
// unit suite drives it without a server. The generated site's booking section is a plain HTML
// POST (no JS dependency — same philosophy as the contact/lead form): the visitor picks a date
// and one of the business's standard times; THIS module is the source of truth for whether that
// slot is actually free at submit time. A conflict never errors opaquely — the endpoint re-offers
// the day's remaining free slots.
//
// Time model (deliberate MVP simplification, documented for the future): all times are the
// BUSINESS's local wall-clock time, stored as plain strings (date 'YYYY-MM-DD', time 'HH:mm')
// with no timezone math anywhere. The confirmation .ics uses floating local time for the same
// reason — correct for the overwhelmingly-local clientele these sites serve (dentists, trades).
//
//   config  = { slotMinutes, daysAhead, openHour, closeHour, openDays: [1..5] (Mon=1..Sun=7) }
//   booking = { id, siteId, date, time, name, email, note, status: 'confirmed'|'cancelled', createdAt }

const { randomUUID } = require('crypto');

const DEFAULTS = { slotMinutes: 30, daysAhead: 14, openHour: 9, closeHour: 17, openDays: [1, 2, 3, 4, 5] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normConfig(cfg = {}) {
  const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  const days = Array.isArray(cfg.openDays) ? cfg.openDays.map(Number).filter((d) => d >= 1 && d <= 7) : DEFAULTS.openDays;
  const c = {
    slotMinutes: [15, 20, 30, 45, 60, 90, 120].includes(Number(cfg.slotMinutes)) ? Number(cfg.slotMinutes) : DEFAULTS.slotMinutes,
    daysAhead: n(cfg.daysAhead, DEFAULTS.daysAhead, 1, 90),
    openHour: n(cfg.openHour, DEFAULTS.openHour, 0, 23),
    closeHour: n(cfg.closeHour, DEFAULTS.closeHour, 1, 24),
    openDays: days.length ? [...new Set(days)].sort() : DEFAULTS.openDays,
  };
  if (c.closeHour <= c.openHour) { c.openHour = DEFAULTS.openHour; c.closeHour = DEFAULTS.closeHour; }
  return c;
}

// ISO weekday (Mon=1..Sun=7) for a 'YYYY-MM-DD' string, timezone-free.
function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const localDateStr = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

// All standard slot times for the configured hours (independent of date/bookings).
function standardSlots(cfg) {
  const c = normConfig(cfg);
  const out = [];
  for (let m = c.openHour * 60; m + c.slotMinutes <= c.closeHour * 60; m += c.slotMinutes) out.push(toTime(m));
  return out;
}

// Free slots for one date: open day, within the window, not already booked, not in the past
// (with a small lead buffer so "book me in 3 minutes" can't happen).
function freeSlots({ cfg, siteId, date, bookings, now = new Date(), leadMinutes = 60 }) {
  const c = normConfig(cfg);
  if (!DATE_RE.test(String(date || ''))) return [];
  if (!c.openDays.includes(isoWeekday(date))) return [];
  const today = localDateStr(now);
  const maxDate = localDateStr(new Date(now.getTime() + c.daysAhead * 864e5));
  if (date < today || date > maxDate) return [];
  const taken = new Set(bookings.filter((b) => b.siteId === siteId && b.date === date && b.status === 'confirmed').map((b) => b.time));
  const minToday = date === today ? now.getHours() * 60 + now.getMinutes() + leadMinutes : -1;
  return standardSlots(c).filter((t) => !taken.has(t) && toMinutes(t) >= minToday);
}

// Validate + reserve. Returns { ok, booking } or { ok:false, error, alternatives? }.
function reserve({ cfg, siteId, date, time, name, email, note = '', bookings, now = new Date() }) {
  if (!DATE_RE.test(String(date || '')) || !TIME_RE.test(String(time || ''))) return { ok: false, error: 'invalid date or time' };
  const free = freeSlots({ cfg, siteId, date, bookings, now });
  if (!free.includes(time)) {
    return { ok: false, error: 'slot unavailable', alternatives: free };
  }
  const dup = bookings.find((b) => b.siteId === siteId && b.email === String(email).toLowerCase() && b.date === date && b.status === 'confirmed');
  if (dup) return { ok: false, error: 'you already have a booking that day', alternatives: [] };
  const booking = {
    id: randomUUID(), siteId,
    date, time,
    name: String(name || '').slice(0, 120),
    email: String(email || '').trim().toLowerCase().slice(0, 200),
    note: String(note || '').slice(0, 1000),
    status: 'confirmed', createdAt: new Date(now).toISOString(),
  };
  bookings.push(booking);
  return { ok: true, booking };
}

function cancel(bookings, id) {
  const b = bookings.find((x) => x.id === id);
  if (!b || b.status !== 'confirmed') return null;
  b.status = 'cancelled';
  b.cancelledAt = new Date().toISOString();
  return b;
}

// Minimal RFC 5545 calendar entry (floating local time — see time-model note above).
// Text fields are escaped per the spec so names/notes can't break the file.
function toIcs(booking, { businessName = '', durationMinutes = 30 } = {}) {
  const escIcs = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const d = booking.date.replace(/-/g, '');
  const start = booking.time.replace(':', '') + '00';
  const endM = toMinutes(booking.time) + durationMinutes;
  const end = toTime(Math.min(endM, 23 * 60 + 59)).replace(':', '') + '00';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AI OS//Booking//EN', 'BEGIN:VEVENT',
    `UID:${booking.id}@ai-os`,
    `DTSTAMP:${new Date(booking.createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
    `DTSTART:${d}T${start}`,
    `DTEND:${d}T${end}`,
    `SUMMARY:${escIcs(`Appointment${businessName ? ` — ${businessName}` : ''}`)}`,
    booking.note ? `DESCRIPTION:${escIcs(booking.note)}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function upcoming(bookings, { siteId = null, now = new Date() } = {}) {
  const today = localDateStr(now);
  return bookings
    .filter((b) => b.status === 'confirmed' && b.date >= today && (!siteId || b.siteId === siteId))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

module.exports = { DEFAULTS, normConfig, standardSlots, freeSlots, reserve, cancel, toIcs, upcoming, isoWeekday, localDateStr };
