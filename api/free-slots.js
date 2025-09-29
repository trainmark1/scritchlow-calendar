import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import { google } from "googleapis";
import { getAuth, toISO, findSlots } from "./_lib.js";

dayjs.extend(utc);
dayjs.extend(tz);

const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID;
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago";
const API_SECRET = process.env.API_SECRET || "";

export default async function handler(req, res) {
  try {
    if (API_SECRET && req.headers["x-api-key"] !== API_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const calendarId  = req.query.calendarId || DEFAULT_CALENDAR_ID;
    const tz          = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit       = Number(req.query.limit || 12);

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    // Rolling window: start-of-today in Central → end-of-day +14 days, unless caller overrides
    let fromISO = toISO(req.query.from);
    let toISOv  = toISO(req.query.to);

    if (!fromISO || !toISOv) {
      const startLocal = dayjs().tz(tz).startOf("day");
      const endLocal   = startLocal.add(14, "day").endOf("day"); // adjust window length as needed
      fromISO = startLocal.utc().toISOString();
      toISOv  = endLocal.utc().toISOString();
    }

    const slots = await findSlots({
      google, calendarId, fromISO, toISO: toISOv, tz, durationMin, maxSlots: limit
    });

    res.status(200).json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
}
