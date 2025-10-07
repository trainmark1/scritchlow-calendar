// index.js
import express from "express";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
app.use(express.json());

/* ========= ENV / CONFIG =========
Required env vars (example .env at bottom):

GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
DEFAULT_CALENDAR_ID=you@gmail.com
DEFAULT_TZ=America/Chicago
API_SECRET=apisecret123
*/
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID || "";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago";
const API_SECRET = process.env.API_SECRET || "";

/* ========= MIDDLEWARE ========= */
function requireSecret(req, res, next) {
  if (!API_SECRET) return next();
  if (req.headers["x-api-key"] === API_SECRET) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/* ========= GOOGLE AUTH ========= */
function getAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";

  if (!clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY");
  }
  // allow \n in env strings
  privateKey = privateKey.replace(/\\n/g, "\n");

  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/calendar"]
  );
}

/* ========= HELPERS ========= */
function toISO(v) {
  if (!v) return undefined;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  return new Date(v).toISOString();
}

// Build free slots inside business hours, skipping anything in the past.
async function findSlots({ calendarId, fromISO, toISO, tz, durationMin, maxSlots }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: fromISO,
      timeMax: toISO,
      timeZone: tz,
      items: [{ id: calendarId }]
    }
  });

  const busy = (fb.data.calendars?.[calendarId]?.busy || [])
    .map(b => ({ start: b.start, end: b.end }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const workStart = "09:00"; // 9 AM local
  const workEnd = "17:00";   // 5 PM local

  const slots = [];
  let cursor = dayjs(fromISO);
  const windowEnd = dayjs(toISO);

  while (cursor.isBefore(windowEnd) && slots.length < maxSlots) {
    const dayLocal = cursor.tz(tz);
    const dayStart = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workStart}`, tz).utc();
    const dayEnd = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workEnd}`, tz).utc();

    if (dayEnd.isAfter(dayjs(fromISO))) {
      let windowStart = dayStart;

      const todaysBusy = busy.filter(
        b => dayjs(b.end).isAfter(dayStart) && dayjs(b.start).isBefore(dayEnd)
      );

      // gaps before each busy block
      for (const b of todaysBusy) {
        const bStart = dayjs(b.start);
        const bEnd = dayjs(b.end);

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

      // tail after last busy block to day end
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

/* ========= ROUTES ========= */

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Quick debug (protected)
app.get("/api/debug-env", requireSecret, (req, res) => {
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY || "";
  res.json({
    hasEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    keyLen: keyRaw.length,
    startsWith: keyRaw.slice(0, 30).replace(/\n/g, "\\n"),
    hasEscapedN: keyRaw.includes("\\n"),
    defaultCal: DEFAULT_CALENDAR_ID,
    defaultTz: DEFAULT_TZ
  });
});

// GET /api/free-slots?calendarId=&from=&to=&tz=&duration=30&limit=12
// Defaults: today -> +14 days in America/Chicago
app.get("/api/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const tz = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit = Number(req.query.limit || 12);

    let fromISO = toISO(req.query.from);
    let toISOVal = toISO(req.query.to);

    if (!fromISO || !toISOVal) {
      const startLocal = dayjs().tz(tz).startOf("day");
      const endLocal = startLocal.add(14, "day").endOf("day"); // adjust range as you wish
      fromISO = startLocal.utc().toISOString();
      toISOVal = endLocal.utc().toISOString();
    }

    const slots = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOVal,
      tz,
      durationMin,
      maxSlots: limit
    });

    res.json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});

// POST /api/book { calendarId, start, end, tz, summary, description }
// No attendees (avoids service-account invite restrictions)
app.post("/api/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz = DEFAULT_TZ,
      summary = "The Scritchlow Agency Consultation",
      description = ""
    } = req.body || {};

    if (!calendarId || !start || !end) {
      return res.status(400).json({ error: "calendarId, start, end are required" });
    }

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const event = await calendar.events.insert({
      calendarId,
      sendUpdates: "none", // do not attempt to email anyone
      requestBody: {
        summary,
        description,
        start: { dateTime: toISO(start), timeZone: tz },
        end:   { dateTime: toISO(end),   timeZone: tz },
        reminders: { useDefault: true }
      }
    });

    res.status(200).json({ ok: true, event: event.data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
});

export default app;
