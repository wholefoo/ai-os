// Booking: slot generation, availability math, reservation semantics (conflict, dup/day,
// past/lead-time exclusion, closed days, horizon), cancellation, .ics shape, and the rendered
// booking section on hosted vs exported sites. Timezone-free by design (see lib/booking.js).
const { assert, done } = require('./test-util');
const bk = require('../lib/booking');
const { renderSection } = require('../lib/web-studio/pipeline');

// A fixed "now": Wednesday 2026-07-15 10:00 local.
const NOW = new Date(2026, 6, 15, 10, 0, 0);
const cfg = { slotMinutes: 30, daysAhead: 14, openHour: 9, closeHour: 17, openDays: [1, 2, 3, 4, 5] };

// --- config normalization
const n = bk.normConfig({ slotMinutes: 7, daysAhead: 9999, openHour: 22, closeHour: 3, openDays: [0, 8, 3] });
// Out-of-range values fall back to DEFAULTS (not clamped to the bound) — garbage in, sane out.
assert(n.slotMinutes === 30 && n.daysAhead === 14 && n.openHour === 9 && n.closeHour === 17 && n.openDays.join() === '3', `garbage config normalizes sanely (${JSON.stringify(n)})`);
assert(bk.normConfig({}).openDays.join() === '1,2,3,4,5', 'empty config gets weekday defaults');

// --- standard slots
const slots = bk.standardSlots(cfg);
assert(slots.length === 16 && slots[0] === '09:00' && slots[slots.length - 1] === '16:30', `9-17 @30min = 16 slots (got ${slots.length})`);
assert(bk.standardSlots({ ...cfg, slotMinutes: 60 }).length === 8, '60min slots halve the count');

// --- freeSlots: weekday logic, past exclusion, lead buffer, horizon
const bookings = [];
assert(bk.freeSlots({ cfg, siteId: 's1', date: '2026-07-18', bookings, now: NOW }).length === 0, 'Saturday (closed day) has no slots');
assert(bk.freeSlots({ cfg, siteId: 's1', date: '2026-07-14', bookings, now: NOW }).length === 0, 'yesterday has no slots');
assert(bk.freeSlots({ cfg, siteId: 's1', date: '2026-09-01', bookings, now: NOW }).length === 0, 'beyond the horizon has no slots');
const today = bk.freeSlots({ cfg, siteId: 's1', date: '2026-07-15', bookings, now: NOW });
assert(today[0] === '11:00', `today at 10:00 + 60min lead buffer → first slot 11:00 (got ${today[0]})`);
const tomorrow = bk.freeSlots({ cfg, siteId: 's1', date: '2026-07-16', bookings, now: NOW });
assert(tomorrow.length === 16, 'a full open future day offers every slot');

// --- reserve: happy path, conflict + alternatives, same-day dup, cross-site independence
const r1 = bk.reserve({ cfg, siteId: 's1', date: '2026-07-16', time: '09:30', name: 'Jane', email: 'Jane@X.com', note: 'first visit', bookings, now: NOW });
assert(r1.ok && r1.booking.email === 'jane@x.com' && bookings.length === 1, 'reservation stores normalized email');
const r2 = bk.reserve({ cfg, siteId: 's1', date: '2026-07-16', time: '09:30', name: 'Bob', email: 'bob@x.com', bookings, now: NOW });
assert(!r2.ok && r2.error === 'slot unavailable' && r2.alternatives.includes('10:00') && !r2.alternatives.includes('09:30'), 'conflict re-offers the day minus the taken slot');
const r3 = bk.reserve({ cfg, siteId: 's1', date: '2026-07-16', time: '10:00', name: 'Jane', email: 'jane@x.com', bookings, now: NOW });
assert(!r3.ok && /already have a booking/.test(r3.error), 'same visitor cannot double-book a day');
const r4 = bk.reserve({ cfg, siteId: 's2', date: '2026-07-16', time: '09:30', name: 'Bob', email: 'bob@x.com', bookings, now: NOW });
assert(r4.ok, 'the same slot on a DIFFERENT site is independent');
assert(!bk.reserve({ cfg, siteId: 's1', date: 'nope', time: '9:3', bookings, now: NOW }).ok, 'malformed date/time rejected');

// --- cancel frees the slot
const c = bk.cancel(bookings, r1.booking.id);
assert(c && c.status === 'cancelled', 'cancel marks the booking');
assert(bk.cancel(bookings, r1.booking.id) === null, 'double-cancel refused');
assert(bk.freeSlots({ cfg, siteId: 's1', date: '2026-07-16', bookings, now: NOW }).includes('09:30'), 'cancelled slot is bookable again');

// --- upcoming: sorted, confirmed-only, site filter
const up = bk.upcoming(bookings, { now: NOW });
assert(up.length === 1 && up[0].siteId === 's2', 'upcoming excludes cancelled, keeps confirmed');

// --- ics: parseable shape + escaping
const ics = bk.toIcs(r4.booking, { businessName: 'Acme; Dental, LLC', durationMinutes: 30 });
assert(/BEGIN:VCALENDAR\r\n/.test(ics) && /DTSTART:20260716T093000/.test(ics) && /DTEND:20260716T100000/.test(ics), 'ics carries correct local start/end');
assert(/Acme\\; Dental\\, LLC/.test(ics), 'ics escapes ; and , in text fields');

// --- rendered section: real form on hosted sites, CTA fallback otherwise, honeypot present
const hosted = renderSection({ type: 'booking', heading: 'Book a visit' }, { bookingEndpoint: 'https://x.com/api/public/booking/s1', bookingSlots: slots });
assert(/method="POST"/.test(hosted) && /name="date"/.test(hosted) && /name="time"/.test(hosted) && /<option value="09:00">/.test(hosted), 'hosted booking section renders the real form with slot options');
assert(/name="website"/.test(hosted), 'booking form carries the spam honeypot');
const exported = renderSection({ type: 'booking', heading: 'Book a visit' }, {});
assert(!/method="POST"/.test(exported) && /Book a visit/.test(exported), 'exported/unhosted site falls back to a CTA (no dead form)');

done();
