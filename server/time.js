// Time helpers. Tekmetric stores times in UTC; the shop works in local time.

// Offset (minutes) of `timeZone` from UTC at a given instant.
export function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// UTC Date for a local wall-clock time on a local date ("2026-10-26", 8, 0).
export function zonedTime(dateStr, hour, minute, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const off1 = tzOffsetMinutes(guess, timeZone);
  const first = new Date(guess.getTime() - off1 * 60000);
  const off2 = tzOffsetMinutes(first, timeZone);
  return off1 === off2 ? first : new Date(guess.getTime() - off2 * 60000);
}

// Local calendar date ("YYYY-MM-DD") of an instant.
export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Local hours since midnight (fractional) of an instant.
export function localHours(date, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(date).map((x) => [x.type, x.value])
  );
  return +p.hour + +p.minute / 60;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Pay period containing dateStr: 1st–15th, or 16th–end of month.
export function payPeriod(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  if (d <= 15) return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-15` };
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad(m)}-16`, end: `${y}-${pad(m)}-${pad(last)}` };
}

// Working days in [start, end] inclusive.
export function workDaysBetween(start, end, workDays) {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (workDays.includes(weekday(d))) n++;
  return n;
}
