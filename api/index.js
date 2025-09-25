import express from "express";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
dayjs.extend(utc); dayjs.extend(tz);

const app = express();
app.use(express.json());

// ---- CONFIG ----
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID; // e.g. markinerfausto@gmail.com
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago";
const API_SECRET = process.env.API_SECRET || ""; // optional shared secret

function requireSecret(req, res, next) {
  if (!API_SECRET) return next();
  if (req.headers["x-api-key"] === API_SECRET) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function getAuth() {
  // IMPORTANT: GOOGLE_PRIVATE_KEY must keep line breaks — replace \n back
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
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  return new Date(v).toISOString();
}

// Simple free-slot finder using FreeBusy + working hours window
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
    .sort((a,b) => new Date(a.start) - new Date(b.start));

  // Customize your working hours here
  const workStart = "09:00"; // 9AM local
  const workEnd   = "17:00"; // 5PM local
  const slots = [];

  let cursor = dayjs(fromISO);
  const end   = dayjs(toISO);

  while (cursor.isBefore(end) && slots.length < maxSlots) {
    const dayLocal = cursor.tz(tz);
    const dayStart = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workStart}`, tz).utc();
    const dayEnd   = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workEnd}`, tz).utc();

    if (dayEnd.isAfter(dayjs(fromISO))) {
      let windowStart = dayStart;
      const todaysBusy = busy.filter(b =>
        dayjs(b.end).isAfter(dayStart) && dayjs(b.start).isBefore(dayEnd)
      );

      for (const b of todaysBusy) {
        const bStart = dayjs(b.start), bEnd = dayjs(b.end);
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

// ---- ROUTES ----

// Healthcheck
app.get("/api/health", (_, res) => res.json({ ok: true }));

// GET /api/free-slots?calendarId=&from=&to=&tz=&duration=30&limit=12
app.get("/api/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId = req.query.calendarId || DEFAULT_CALENDAR_ID;
    const tz = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit = Number(req.query.limit || 12);
    const fromISO = toISO(req.query.from) || dayjs().utc().startOf("day").toISOString();
    const toISO   = toISO(req.query.to)   || dayjs().utc().add(14, "day").endOf("day").toISOString();
    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const slots = await findSlots({ calendarId, fromISO, toISO, tz, durationMin, maxSlots: limit });
    res.json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});

// POST /api/book  { calendarId, start, end, tz, summary, description, attendees:[{email,name}] }
app.post("/api/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start, end,
      tz = DEFAULT_TZ,
      summary = "Financial Planning Consultation",
      description = "",
      attendees = [] // optional: [{email,name}]
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
        reminders: { useDefault: true }
      }
    });

    res.json({ ok: true, event: event.data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
});

export default app;