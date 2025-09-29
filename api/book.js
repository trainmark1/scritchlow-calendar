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

    // Format a friendly label
    const label = dayjs(start).tz(tz).format("dddd, MMMM D, h:mm A [Central Time]");

    res.json({
      ok: true,
      event: event.data,
      label,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "book error" });
  }
});
