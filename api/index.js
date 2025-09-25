// api/index.js
import express from "express";
import serverless from "serverless-http";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
app.use(express.json());

/* -------------------- CONFIG -------------------- */
// Set these in Vercel → Project → Settings → Environment Variables
// - DEFAULT_CALENDAR_ID        e.g. markinerfausto@gmail.com
// - DEFAULT_TZ                 e.g. America/Chicago
// - API_SECRET                 (optional) shared key for X-API-Key
// - GOOGLE_CLIENT_EMAIL        from your service account JSON
// - GOOGLE_PRIVATE_KEY         from the JSON (keep line breaks; replace \n back)
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID;
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago";
const API_SECRET = process.env.API_SECRET || "";

/* -------------------- HELPERS -------------------- */
function requireSecret(req, res, next) {
  if (!API_SECRET) return next(); // open if not set
  if (req.headers["x-api-key"] === API_SECRET) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function getAuth() {
  // IMPORTANT: keep line breaks in private key
  const pk = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    pk,
    ["https://www.googleapis.com/auth/calendar"]
  );
}

function toISO(v) {
  if (!v) return undefined;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString(); // epoch ms
  return new Date(v).toISOString();
}

/**
 * Find free slots using FreeBusy within business hours.
 * @param {Object} params
 * @param {string} params.calendarId
 * @param {string} params.fromISO  UTC ISO
 * @param {string} params.toISO    UTC ISO
 * @param {string} params.tz       IANA TZ
 * @param {number} params.durationMin
 * @param {number} params.maxSlots
 */
async function findSlots({ calendarId, fromISO, toISO, tz, durationMin, maxSlots }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  // Busy blocks in range
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: fromISO,
      timeMax: toISO,
      timeZone: tz,
      items: [{ id: calendarId }],
    },
  });

  const busy = (fb.data.calendars?.[calendarId]?.busy || [])
    .map(b => ({ start: b.start, end: b.end }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  // Business hours (local time)
  const workStart = "09:00"; // 9AM
  const workEnd   = "17:00"; // 5PM

  const slots = [];
  let cursor = dayjs(fromISO);
  const rangeEnd = dayjs(toISO);

  while (cursor.isBefore(rangeEnd) && slots.length < maxSlots) {
    const dayLocal = cursor.tz(tz);
    const dayStart = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workStart}`, tz).utc();
    const dayEnd   = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workEnd}`, tz).utc();

    if (dayEnd.isAfter(dayjs(fromISO))) {
      let windowStart = dayStart;

      // Busy blocks intersecting this work day
      const todaysBusy = busy.filter(
        b => dayjs(b.end).isAfter(dayStart) && dayjs(b.start).isBefore(dayEnd)
      );

      // Fill gaps before each busy block
      for (const b of todaysBusy) {
        const bStart = dayjs(b.start);
        const bEnd   = dayjs(b.end);

        if (bStart.isAfter(windowStart)) {
          let slotStart = windowStart;
          while (slotStart.add(durationMin, "minute").isSameOrBefore(bStart)) {
            const slotEnd = slotStart.add(durationMin, "minute");
            if (slotStart.isAfter(dayjs())) {
              slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
              if (slots.length >= maxSlots) break;
            }
            slotStart = slotStart.add(durationMin, "minute");
          }
        }

        if (bEnd.isAfter(windowStart)) windowStart = bEnd;
        if (slots.length >= maxSlots) break;
      }

      // Fill remainder to dayEnd
      if (slots.length < maxSlots && windowStart.isBefore(dayEnd)) {
        let slotStart = windowStart;
        while (slotStart.add(durationMin, "minute").isSameOrBefore(dayEnd)) {
          const slotEnd = slotStart.add(durationMin, "minute");
          if (slotStart.isAfter(dayjs())) {
            slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
            if (slots.length >= maxSlots) break;
          }
          slotStart = slotStart.add(durationMin, "minute");
        }
      }
    }

    cursor = cursor.add(1, "day");
  }

  return slots;
}

/* -------------------- ROUTES (mounted under /api/* on Vercel) -------------------- */

// Healthcheck → GET /api/health
app.get("/health", (_, res) => res.json({ ok: true }));

// Free slots → GET /api/free-slots?calendarId=&from=&to=&tz=&duration=30&limit=12
app.get("/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId  = req.query.calendarId || DEFAULT_CALENDAR_ID;
    const tz          = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit       = Number(req.query.limit || 12);

    const fromISO = toISO(req.query.from) || dayjs().utc().startOf("day").toISOString();
    const toISOv  = toISO(req.query.to)   || dayjs().utc().add(14, "day").endOf("day").toISOString();

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const slots = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOv,
      tz,
      durationMin,
      maxSlots: limit,
    });

    res.json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});

// Book appointment → POST /api/book
// Body: { calendarId, start, end, tz, summary, description, attendees:[{email,name}] }
app.post("/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz = DEFAULT_TZ,
      summary = "Financial Planning Consultation",
      description = "",
      attendees = [], // optional
    } = req.body;

    if (!calendarId || !start || !end) {
      return res.status(400).json({ error: "calendarId, start, end are required" });
    }

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const event = await calendar.events.insert({
      calendarId,
      sendUpdates: "all",
      requestBody: {
        summary,
        description,
        start: { dateTime: toISO(start), timeZone: tz },
        end:   { dateTime: toISO(end),   timeZone: tz },
        attendees,
        reminders: { useDefault: true },
      },
    });

    res.json({ ok: true, event: event.data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
});

/* -------------------- Vercel handler -------------------- */
export default serverless(app);
