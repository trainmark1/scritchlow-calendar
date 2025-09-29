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

/* ======================= CONFIG ======================= */
const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID || "";
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago"; // Bloomington, IL (Central Time)
const API_SECRET = process.env.API_SECRET || "";                 // require x-api-key if set

// 9 AM – 5 PM local business window
const WORK_START = "09:00";
const WORK_END   = "17:00";

// helper: API key guard
function requireSecret(req, res, next) {
  if (!API_SECRET) return next();
  const given = req.headers["x-api-key"];
  if (given && given === API_SECRET) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// helper: Google auth (service account)
function getAuth() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || "";
  // Accept either multiline or \n-escaped
  const key = raw.includes("\n") ? raw : raw.replace(/\\n/g, "\n");

  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    key,
    ["https://www.googleapis.com/auth/calendar"]
  );
}

// helper: normalize to ISO
function toISO(v) {
  if (!v) return undefined;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString(); // epoch ms
  return new Date(v).toISOString();
}

// helper: human labels for the bot (always Central Time)
function labelSlot(startISO, endISO, tz = DEFAULT_TZ) {
  const s = dayjs(startISO).tz(tz);
  const e = dayjs(endISO).tz(tz);
  // e.g. Thu Sep 26, 10:00–10:30 AM Central Time
  const dayPart = s.format("ddd MMM D");
  const timePart = `${s.format("h:mm A")}–${e.format("h:mm A")}`;
  return `${dayPart}, ${timePart} Central Time`;
}

/* =================== FREE SLOTS CORE =================== */
/**
 * Finds free slots using Calendar FreeBusy + 9–5 local window.
 * durationMin: minutes per slot
 * maxSlots: cap how many to return
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
    .map(b => ({ start: b.start, end: b.end }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const results = [];
  let cursor = dayjs(fromISO);
  const hardEnd = dayjs(toISO);

  while (cursor.isBefore(hardEnd) && results.length < maxSlots) {
    // daily 9–5 window in TZ, compared in UTC
    const localDay = cursor.tz(tz);
    const dayStart = dayjs.tz(`${localDay.format("YYYY-MM-DD")}T${WORK_START}`, tz).utc();
    const dayEnd   = dayjs.tz(`${localDay.format("YYYY-MM-DD")}T${WORK_END}`, tz).utc();

    if (dayEnd.isAfter(dayjs(fromISO))) {
      let windowStart = dayStart;

      // relevant busy blocks for this day
      const todaysBusy = busy.filter(b =>
        dayjs(b.end).isAfter(dayStart) && dayjs(b.start).isBefore(dayEnd)
      );

      // slots before the first busy, then between busy blocks
      for (const b of todaysBusy) {
        const bStart = dayjs(b.start);
        const bEnd = dayjs(b.end);

        if (bStart.isAfter(windowStart)) {
          let slotStart = windowStart;
          while (slotStart.add(durationMin, "minute").isSameOrBefore(bStart)) {
            const slotEnd = slotStart.add(durationMin, "minute");
            if (slotStart.isAfter(dayjs())) {
              results.push({
                start: slotStart.toISOString(),
                end: slotEnd.toISOString(),
                label: labelSlot(slotStart.toISOString(), slotEnd.toISOString(), tz),
              });
              if (results.length >= maxSlots) break;
            }
            slotStart = slotStart.add(durationMin, "minute");
          }
        }

        if (bEnd.isAfter(windowStart)) windowStart = bEnd;
        if (results.length >= maxSlots) break;
      }

      // tail after last busy
      if (results.length < maxSlots && windowStart.isBefore(dayEnd)) {
        let slotStart = windowStart;
        while (slotStart.add(durationMin, "minute").isSameOrBefore(dayEnd)) {
          const slotEnd = slotStart.add(durationMin, "minute");
          if (slotStart.isAfter(dayjs())) {
            results.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              label: labelSlot(slotStart.toISOString(), slotEnd.toISOString(), tz),
            });
            if (results.length >= maxSlots) break;
          }
          slotStart = slotStart.add(durationMin, "minute");
        }
      }
    }

    cursor = cursor.add(1, "day");
  }

  return results;
}

/* ======================= ROUTES ======================== */

// Health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Free slots
// Query params supported:
// - calendarId: string (default DEFAULT_CALENDAR_ID)
// - tz: IANA tz (default America/Chicago)
// - duration: minutes (default 30)
// - limit: how many slots to return (default 5)
// - range: "week" | "month" | "custom" (default "week")
// - from, to: ISO strings; if both given, override range
app.get("/api/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId = (req.query.calendarId || DEFAULT_CALENDAR_ID).toString();
    const tz = (req.query.tz || DEFAULT_TZ).toString();
    const durationMin = Number(req.query.duration || 30);
    const limit = Number(req.query.limit || 5);
    const range = (req.query.range || "week").toString(); // week | month | custom

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    // Build time window
    let fromISO = toISO(req.query.from);
    let toISOv  = toISO(req.query.to);

    const now = dayjs().tz(tz);
    if (!fromISO || !toISOv) {
      const start = now.add(15, "minute"); // avoid too-near-now
      let end;
      if (range === "month") {
        end = start.add(1, "month").endOf("day");
      } else if (range === "custom") {
        // fall back to 14 days if custom requested without explicit from/to
        end = start.add(14, "day").endOf("day");
      } else {
        // default: week
        end = start.add(7, "day").endOf("day");
      }
      fromISO = start.utc().toISOString();
      toISOv  = end.utc().toISOString();
    }

    // Guard bad windows
    if (dayjs(toISOv).isSameOrBefore(dayjs(fromISO))) {
      return res.status(400).json({ error: "invalid window: to must be after from" });
    }

    const slots = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOv,
      tz,
      durationMin,
      maxSlots: limit,
    });

    res.json({
      tz,
      durationMin,
      range,
      from: fromISO,
      to: toISOv,
      count: slots.length,
      slots,                       // [{start, end, label}]
      labels: slots.map(s => s.label), // convenience for quick prompts
    });
  } catch (e) {
    console.error("free-slots error:", e?.response?.data || e?.message || e);
    res.status(502).json({
      error: "free-slots failed",
      detail: e?.response?.data || e?.message || "unknown",
    });
  }
});

// Book
// Body JSON:
// {
//   "calendarId": "optional (defaults to DEFAULT_CALENDAR_ID)",
//   "start": "<ISO>",
//   "end": "<ISO>",
//   "tz": "America/Chicago",              // default
//   "summary": "Financial Planning Consultation",
//   "description": "",
//   "attendees": [ { "email": "", "name": "" } ]  // optional; service accounts often cannot invite externally
// }
app.post("/api/book", requireSecret, async (req, res) => {
  try {
    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz = DEFAULT_TZ,
      summary = "Financial Planning Consultation",
      description = "",
      attendees = [],
    } = req.body || {};

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
        attendees, // NOTE: many service accounts can't invite externals—ok to leave empty
        reminders: { useDefault: true },
      },
    });

    res.json({
      ok: true,
      event: event.data,
    });
  } catch (e) {
    console.error("book error:", e?.response?.data || e?.message || e);
    res.status(502).json({
      error: "book failed",
      detail: e?.response?.data || e?.message || "unknown",
    });
  }
});

export default app;
