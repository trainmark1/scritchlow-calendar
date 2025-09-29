// GET /api/free-slots?range=week|fortnight|month|custom
app.get("/free-slots", requireSecret, async (req, res) => {
  try {
    const calendarId  = req.query.calendarId || DEFAULT_CALENDAR_ID;
    const tz          = req.query.tz || DEFAULT_TZ;
    const durationMin = Number(req.query.duration || 30);
    const limit       = Math.min(Number(req.query.limit || 12), 200);
    const range       = (req.query.range || "fortnight").toLowerCase();

    if (!calendarId) return res.status(400).json({ error: "missing calendarId" });

    // Always start from "today" in local tz
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
      toISOVal = nowLocal.add(14, "day").endOf("day").utc().toISOString();
    }

    const slotsRaw = await findSlots({
      calendarId,
      fromISO,
      toISO: toISOVal,
      tz,
      durationMin,
      maxSlots: limit * 4
    });

    const nowUtc = dayjs().utc().add(1, "minute");
    const slots = slotsRaw
      .filter(s => dayjs(s.start).isAfter(nowUtc))
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, limit);

    res.json({
      slots,
      tz,
      durationMin,
      window: { fromISO, toISO: toISOVal, range }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "free-slots error" });
  }
});