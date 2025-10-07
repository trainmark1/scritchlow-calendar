import express from "express";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
app.use(express.json());

/* ============= CONFIG ============= */
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID || "";           // e.g. you@gmail.com
const DEFAULT_TZ          = process.env.DEFAULT_TZ || "America/Chicago";     // Central Time
const API_SECRET          = process.env.API_SECRET || "";                    // optional shared secret

/* ============= MIDDLEWARE ============= */
function requireSecret(req, _res, next) {
  if (!API_SECRET) return next();
  if (req.headers["x-api-key"] === API_SECRET) return next();
  return next({ status: 401, message: "unauthorized" });
}

/* ============= GOOGLE AUTH ============= */
function getAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey    = process.env.GOOGLE_PRIVATE_KEY || "";

  if (!privateKey || !clientEmail) {
    throw new Error("Google credentials missing. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.");
  }
  privateKey = privateKey.replace(/\\n/g, "\n");

  return new google.auth.JWT(clientEmail, null, privateKey, [
    "https://www.googleapis.com/auth/calendar",
  ]);
}

/* ============= HELPERS ============= */
function toISO(v) {
  if (!v) return undefined;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString(); // epoch ms
  return new Date(v).toISOString();
}

function isEmail(s) {
  return typeof s === "string" && /\S+@\S+\.\S+/.test(s);
}

/**
 * Find free slots using FreeBusy combined with a business-hours window.
 * - 09:00–17:00 local business hours
 * - No slots in the past
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

  const workStart = "09:00";
  const workEnd   = "17:00";

  const slots = [];
  let cursor = dayjs(fromISO);
  const end = dayjs(toISO);

  while (cursor.isBefore(end) && slots.length < maxSlots) {
    const dayLocal = cursor.tz(tz);
    const dayStart = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workStart}`, tz).utc();
    const dayEnd   = dayjs.tz(`${dayLocal.format("YYYY-MM-DD")}T${workEnd}`, tz).utc();

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

/* ============= ROUTES ============= */

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/debug-env", requireSecret, (_req, res) => {
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY || "";
  res.json({
    hasEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    keyLen: keyRaw.length,
    startsWith: keyRaw.slice(0, 30).replace(/\n/g, "\\n"),
    hasEscapedN: keyRaw.includes("\\n"),
    defaultCal: DEFAULT_CALENDAR_ID,
    defaultTz: DEFAULT_TZ,
  });
});

// GET /api/free-slots?calendarId=&from=&to=&tz=&duration=30&limit=12
app.get("/api/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId  = req.query.calendarId || DEFAULT_CALENDAR_ID;
    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const tz          = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const maxSlots    = Number(req.query.limit || 12);

    // today (in TZ) -> +14d window unless overridden
    let fromISO = toISO(req.query.from);
    let toISOv  = toISO(req.query.to);
    if (!fromISO || !toISOv) {
      const startLocal = dayjs().tz(tz).startOf("day");
      const endLocal   = startLocal.add(14, "day").endOf("day");
      fromISO = startLocal.utc().toISOString();
      toISOv  = endLocal.utc().toISOString();
    }

    const slots = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOv,
      tz,
      durationMin,
      maxSlots,
    });

    res.json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});

// POST /api/book
// body: { calendarId?, start, end, tz?, summary?, description?, attendees? }
app.post("/api/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz         = DEFAULT_TZ,
      summary    = "Financial Planning Consultation",
      description = "",
      metadata = {}, // optional { email, first_name, last_name }
    } = req.body || {};

    // attendees may arrive as array or JSON-string; normalize
    let attendees = req.body?.attendees ?? [];
    if (typeof attendees === "string") {
      try { attendees = JSON.parse(attendees); } catch { attendees = []; }
    }
    if (!Array.isArray(attendees)) attendees = [];

    // Fallback to metadata if attendees empty and email present
    if (!attendees.length && isEmail(metadata.email)) {
      attendees.push({
        email: metadata.email,
        displayName: [metadata.first_name, metadata.last_name].filter(Boolean).join(" ").trim(),
      });
    }

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
        attendees,                        // <- guests
        reminders: { useDefault: true },
      },
    });

    res.json({
      ok: true,
      event: event.data,
      eventLink: event.data?.htmlLink || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
});

/* ============= ERROR HANDLER ============= */
app.use((err, _req, res, _next) => {
  const code = err?.status || 500;
  res.status(code).json({ error: err?.message || "server_error" });
});

export default app;
