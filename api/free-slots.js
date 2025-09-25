import { google } from "googleapis";
import { getAuth, toISO, findSlots } from "./_lib.js";

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

    const now = new Date();
    const fromISO = toISO(req.query.from) || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const toISOv  = toISO(req.query.to)   || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+14, 23,59,59)).toISOString();

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    const slots = await findSlots({
      google, calendarId, fromISO, toISO: toISOv, tz, durationMin, maxSlots: limit
    });

    res.status(200).json({ slots, tz, durationMin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
}
