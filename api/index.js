// api/index.js
import express from "express";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
app.use(express.json());

/* -------------------- CONFIG -------------------- */
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID; // e.g. markinerfausto@gmail.com
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago"; // Bloomington, IL (Central Time)
const API_SECRET = process.env.API_SECRET || ""; // optional shared secret

function requireSecret(req, res, next) {
  if (!API_SECRET) return next(); // not set → open
  if (req.headers["x-api-key"] === API_SECRET) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function getAuth() {
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

/**
 * Find free slots within given window & working hours.
 */
async function findSlots({ calendarId, fromISO, toISO, tz, durationMin, maxSlots }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: fromISO,
      timeMax: toISO,
      timeZone: tz,
      items: [{ id: calendarId }],
    },
  });

  const busy = (fb.data.calendars?.[calendarId]?.busy || [])
    .map((b) => ({ start: b.start, end: b.end }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const workStart = "09:00"; // 9 AM local
  const workEnd = "17:00";   // 5 PM local

  const slots = [];
  let cursor = dayjs(fromISO);
  const end = dayjs(toISO);

  while (cursor.isBefore(end) && slots.length < maxSlots) {
    const dayLocal = cursor.tz(tz);
    const dayStart = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workStart}`, tz).utc();
    const dayEnd = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workEnd}`, tz).utc();

    if (dayEnd.isAfter(dayjs(fromISO))) {
      let windowStart = dayStart;

      const todaysBusy = busy.filter(
        (b) => dayjs(b.end).isAfter(dayStart) && dayjs(b.start).isBefore(dayEnd)
      );

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

/* -------------------- ROUTES -------------------- */

// Healthcheck
app.get("/health", (_, res) => res.json({ ok: true }));

// Free slots
app.get("/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId  = req.query.calendarId || DEFAULT_CALENDAR_ID;
    const tz          = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit       = Math.min(Number(req.query.limit || 12), 200);
    const range       = (req.query.range || "month").toLowerCase(); // default = month

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const nowLocal = dayjs().tz(tz).startOf("day");
    let fromISO = nowLocal.utc().toISOString();
    let toISOVal;

    if (range === "week") {
      toISOVal = nowLocal.add(7, "day").endOf("day").utc().toISOString();
    } else if (range === "fortnight") {
      toISOVal = nowLocal.add(14, "day").endOf("day").utc().toISOString();
    } else if (range === "month") {
      toISOVal = nowLocal.endOf("month").endOf("day").utc().toISOString();
    } else if (range === "custom") {
      const f = toISO(req.query.from);
      const t = toISO(req.query.to);
      if (!f || !t) return res.status(400).json({ error: "for range=custom you must supply from & to" });
      fromISO = f;
      toISOVal = t;
    } else {
      toISOVal = nowLocal.endOf("month").endOf("day").utc().toISOString();
    }

    const slotsRaw = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOVal,
      tz,
      durationMin,
      maxSlots: limit * 4,
    });

    const nowUtc = dayjs().utc().add(1, "minute");
    const slots = slotsRaw
      .filter((s) => dayjs(s.start).isAfter(nowUtc))
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, limit)
      .map((s) => ({
        ...s,
        label: dayjs(s.start).tz(tz).format("dddd, MMMM D, h:mm A [Central Time]"),
      }));

    res.json({
      slots,
      tz,
      durationMin,
      window: { fromISO, toISO: toISOVal, range },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});

// Book appointment
app.post("/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz = DEFAULT_TZ,
      summary = "Financial Planning Consultation",
      description = "",
      attendees = [],
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
        end: { dateTime: toISO(end), timeZone: tz },
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

export default app;
