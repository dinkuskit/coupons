// Money and calendar days as a store owner reads and types them. Plain data: no EmDash, no storage.

/** Whole cents: at most 1,000,000,000 (ten million dollars), as the add-ons door takes them. */
export const MAX_CENTS = 1_000_000_000n;

const DOLLARS = /^\$?\s*(\d{1,8})(?:\.(\d{1,2}))?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** Typed dollars, such as "12.50", "$1,200" or "5", as whole cents; null when it is not an amount. */
export function cents(text: string): bigint | null {
  const match = DOLLARS.exec(text.replaceAll(",", "").trim());
  if (!match) return null;
  const value = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return value <= MAX_CENTS ? value : null;
}

/** Whole cents as dollars, such as "$1,200.50". */
export function usd(minor: bigint | string): string {
  const digits = String(minor).padStart(3, "0");
  return `$${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-2)}`;
}

/** Whole cents as the dollars a form field shows, such as "12.50". */
export const dollarsText = (minor: string) => usd(minor).slice(1).replaceAll(",", "");

/** The US time zones and UTC, which the owner picks the store's time zone from. */
export const TIME_ZONES = [
  { label: "Eastern (New York)", value: "America/New_York" },
  { label: "Central (Chicago)", value: "America/Chicago" },
  { label: "Mountain (Denver)", value: "America/Denver" },
  { label: "Arizona (Phoenix)", value: "America/Phoenix" },
  { label: "Pacific (Los Angeles)", value: "America/Los_Angeles" },
  { label: "Alaska (Anchorage)", value: "America/Anchorage" },
  { label: "Hawaii (Honolulu)", value: "Pacific/Honolulu" },
  { label: "UTC", value: "UTC" },
];
export const DEFAULT_ZONE = "America/New_York";

export function validZone(timeZone: string): boolean {
  if (!ZONE.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function zoneParts(instant: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An instant as the store's wall-clock time, such as "Dec 31, 2026, 11:59 PM EST". */
export function when(instant: string, timeZone: string): string {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return instant;
  try {
    const parts = zoneParts(time, timeZone);
    const hour = Number(parts.hour);
    return `${MONTHS[Number(parts.month) - 1]} ${Number(parts.day)}, ${parts.year}, ${hour % 12 || 12}:${parts.minute} ${hour < 12 ? "AM" : "PM"} ${parts.timeZoneName}`;
  } catch {
    return instant;
  }
}

/** The calendar day an instant falls on in a time zone, as a date field shows it. */
export function dayIn(instant: string, timeZone: string): string {
  const parts = zoneParts(Date.parse(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function offsetMinutes(utc: number, timeZone: string): number {
  const parts = zoneParts(utc, timeZone);
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour! % 24, +parts.minute!, +parts.second!);
  return Math.round((wall - utc) / 60000);
}

/** The first (00:00:00) or last (23:59:59) second of a calendar day in a time zone, as a UTC instant; null for no such day. */
export function dayEdge(day: string, edge: "start" | "end", timeZone: string): string | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || date < 1 || date > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const wall = edge === "start" ? Date.UTC(year, month - 1, date) : Date.UTC(year, month - 1, date, 23, 59, 59);
  // Twice, so a day next to a daylight-saving change gets that moment's offset.
  let offset = offsetMinutes(wall, timeZone);
  offset = offsetMinutes(wall - offset * 60000, timeZone);
  return new Date(wall - offset * 60000).toISOString();
}
