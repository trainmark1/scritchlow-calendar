import { google } from "googleapis";

export function getAuth() {
  const pk = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    pk,
    ["https://www.googleapis.com/auth/calendar"]
  );
}

export function toISO(v) {
  if (!v) return undefined;
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  return new Date(v).toISOString();
}

export async function findSlots({ google, calendarId, fromISO, toISO, tz, durationMin, maxSlots }) {
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

  // simple business hours window (local)
  const workStart = "09:00"; // 9 AM
  const workEnd   = "17:00"; // 5 PM

  // minimal slot builder without external libraries
  const dayjs = d => new Date(d);
  const addMin = (d, m) => new Date(dayjs(d).getTime() + m*60000);

  const slots = [];
  let cursor = new Date(fromISO);
  const endRange = new Date(toISO);

  while (cursor < endRange && slots.length < maxSlots) {
    const yyyy = cursor.getUTCFullYear();
    const mm = String(cursor.getUTCMonth()+1).padStart(2,"0");
    const dd = String(cursor.getUTCDate()).padStart(2,"0");

    const dayStartLocal = new Date(`${yyyy}-${mm}-${dd}T${workStart}:00${offsetForTZ(tz)}`);
    const dayEndLocal   = new Date(`${yyyy}-${mm}-${dd}T${workEnd}:00${offsetForTZ(tz)}`);

    const dayStart = toUtcISO(dayStartLocal);
    const dayEnd   = toUtcISO(dayEndLocal);

    let windowStart = new Date(dayStart);

    const todaysBusy = busy.filter(b =>
      new Date(b.end) > new Date(dayStart) && new Date(b.start) < new Date(dayEnd)
    );

    for (const b of todaysBusy) {
      const bStart = new Date(b.start);
      const bEnd   = new Date(b.end);

      if (bStart > windowStart) {
        let slotStart = new Date(windowStart);
        while (addMin(slotStart, durationMin) <= bStart) {
          const slotEnd = addMin(slotStart, durationMin);
          if (slotStart > new Date()) {
            slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
            if (slots.length >= maxSlots) break;
          }
          slotStart = addMin(slotStart, durationMin);
        }
      }
      if (bEnd > windowStart) windowStart = bEnd;
      if (slots.length >= maxSlots) break;
    }

    if (slots.length < maxSlots && windowStart < new Date(dayEnd)) {
      let slotStart = new Date(windowStart);
      while (addMin(slotStart, durationMin) <= new Date(dayEnd)) {
        const slotEnd = addMin(slotStart, durationMin);
        if (slotStart > new Date()) {
          slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
          if (slots.length >= maxSlots) break;
        }
        slotStart = addMin(slotStart, durationMin);
      }
    }

    cursor = new Date(cursor.getTime() + 86400000);
  }

  return slots;
}

// crude fixed offset for common US TZs; good enough to get you running
function offsetForTZ(tz) {
  // You can add more mappings as needed.
  const map = {
    "America/New_York": "-04:00",
    "America/Chicago":  "-05:00",
    "America/Denver":   "-06:00",
    "America/Los_Angeles": "-07:00",
  };
  return map[tz] || "-05:00";
}
function toUtcISO(d) {
  return new Date(d).toISOString();
}