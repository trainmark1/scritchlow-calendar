import { google } from "googleapis";
import { getAuth, toISO } from "./_lib.js";

const DEFAULT_CALENDAR_ID = process.env.DEFAULT_CALENDAR_ID;
const DEFAULT_TZ = process.env.DEFAULT_TZ || "America/Chicago";
const API_SECRET = process.env.API_SECRET || "";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    if (API_SECRET && req.headers["x-api-key"] !== API_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const {
      calendarId = DEFAULT_CALENDAR_ID,
      start,
      end,
      tz = DEFAULT_TZ,                                        // default to Central Time
      summary = "Financial Planning Consultation",
      description = "",
      attendees = []
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
        end:   { dateTime: toISO(end),   timeZone: tz },
        attendees,
        reminders: { useDefault: true },
      }
    });

    res.status(200).json({ ok: true, event: event.data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
}
