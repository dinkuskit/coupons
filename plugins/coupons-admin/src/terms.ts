// Coupon terms as a store owner reads and types them, and as the coupon
// service stores them. Everything here is plain data: no EmDash, no network.

export interface Money { currency: "USD"; minor: string }
export interface Rule {
  ruleId: string;
  version: number;
  discount: { kind: "percentage"; basisPoints: number; maximum?: Money } | { kind: "fixed"; amount: Money };
  appliesTo: "all-merchandise" | "selected-products";
  selectedProductIds: string[];
  includeSaleItems: boolean;
  minimumEligibleMerchandise: Money;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}
export interface Coupon {
  couponId: string;
  code: string;
  disabled: boolean;
  globalCap: number;
  revision: number;
  rule: Rule;
  createdAt?: string;
}

/** What the coupon form holds: the text the owner typed, so a refused form comes back as they left it. */
export interface Draft {
  code: string;
  kind: "percentage" | "fixed";
  percent: string;
  maxDiscount: string;
  amount: string;
  minSpend: string;
  products: string;
  includeSale: boolean;
  startsOn: string;
  endsOn: string;
  timeZone: string;
  uses: string;
  startOff: boolean;
}

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

const DOLLARS = /^\$?\s*(\d{1,12})(?:\.(\d{1,2}))?$/;
const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;
const MAX_PRODUCTS = 100;
const MAX_USES = 999_999_999;

// --- Reading terms --------------------------------------------------------

export function usd(money: Money | undefined): string {
  if (!money || !/^\d+$/.test(money.minor)) return "-";
  const digits = money.minor.padStart(3, "0");
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${digits.slice(-2)}`;
}

function percentText(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

export function discountText(rule: Rule): string {
  const discount = rule.discount;
  if (discount.kind === "fixed") return `${usd(discount.amount)} off`;
  const percent = `${percentText(discount.basisPoints)} off`;
  return discount.maximum ? `${percent}, at most ${usd(discount.maximum)}` : percent;
}

export function scopeText(rule: Rule): string {
  return rule.appliesTo === "selected-products" ? `Products ${rule.selectedProductIds.join(", ")}` : "Every product";
}

function zoneParts(instant: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      second: "2-digit", hourCycle: "h23", timeZoneName: "short",
    }).formatToParts(new Date(instant)).map(part => [part.type, part.value]),
  );
}

/** An instant as wall-clock time in the coupon's own time zone, which is how the owner entered it. */
export function when(instant: string, timeZone: string): string {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return instant;
  try {
    const parts = zoneParts(time, timeZone);
    const seconds = parts.second === "00" ? "" : `:${parts.second}`;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds} ${parts.timeZoneName}`;
  } catch {
    return instant;
  }
}

/** The calendar day an instant falls on in a time zone, as a date field shows it. */
export function dayIn(instant: string, timeZone: string): string {
  const parts = zoneParts(Date.parse(instant), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zoneLabel(timeZone: string): string {
  return TIME_ZONES.find(zone => zone.value === timeZone)?.label ?? timeZone;
}

/** Whether shoppers can use the coupon right now, and if not, why. */
export function couponState(coupon: Pick<Coupon, "disabled" | "rule">, now = Date.now()): "Off" | "Ended" | "Scheduled" | "On" {
  if (coupon.disabled) return "Off";
  if (Date.parse(coupon.rule.endsAt) <= now) return "Ended";
  if (Date.parse(coupon.rule.startsAt) > now) return "Scheduled";
  return "On";
}

/** The facts an owner checks before confirming a change, in reading order. */
export function couponFacts(coupon: Pick<Coupon, "code" | "disabled" | "globalCap" | "rule">): Array<[string, string]> {
  const rule = coupon.rule;
  return [
    ["Code", coupon.code],
    ["Status", coupon.disabled ? "Off" : "On"],
    ["Discount", discountText(rule)],
    ["Applies to", scopeText(rule)],
    ["Sale items", rule.includeSaleItems ? "Discounted too" : "Not discounted"],
    ["Minimum spend", usd(rule.minimumEligibleMerchandise)],
    ["Starts", when(rule.startsAt, rule.timeZone)],
    ["Ends", when(rule.endsAt, rule.timeZone)],
    ["Time zone", zoneLabel(rule.timeZone)],
    ["Uses allowed", String(coupon.globalCap)],
  ];
}

// --- Drafts ---------------------------------------------------------------

function dollarsText(money: Money): string {
  const digits = money.minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function newDraft(): Draft {
  return {
    code: "", kind: "percentage", percent: "", maxDiscount: "", amount: "", minSpend: "0", products: "",
    includeSale: false, startsOn: "", endsOn: "", timeZone: "America/New_York", uses: "", startOff: false,
  };
}

export function draftFromCoupon(coupon: Coupon): Draft {
  const { rule } = coupon;
  const discount = rule.discount;
  return {
    code: coupon.code,
    kind: discount.kind,
    percent: discount.kind === "percentage" ? String(discount.basisPoints / 100) : "",
    maxDiscount: discount.kind === "percentage" && discount.maximum ? dollarsText(discount.maximum) : "",
    amount: discount.kind === "fixed" ? dollarsText(discount.amount) : "",
    minSpend: dollarsText(rule.minimumEligibleMerchandise),
    products: rule.selectedProductIds.join(", "),
    includeSale: rule.includeSaleItems,
    startsOn: dayIn(rule.startsAt, rule.timeZone),
    endsOn: dayIn(rule.endsAt, rule.timeZone),
    timeZone: rule.timeZone,
    uses: String(coupon.globalCap),
    startOff: coupon.disabled,
  };
}

function textValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}

/** A submitted form, read field by field. Fields the form hid or the owner left alone may be missing. */
export function draftFromValues(values: Record<string, unknown>): Draft {
  return {
    code: textValue(values.code),
    kind: values.discount_kind === "fixed" ? "fixed" : "percentage",
    percent: textValue(values.percent),
    maxDiscount: textValue(values.max_discount),
    amount: textValue(values.amount),
    minSpend: textValue(values.min_spend),
    products: textValue(values.products),
    includeSale: values.include_sale_items === true,
    startsOn: textValue(values.starts_on),
    endsOn: textValue(values.ends_on),
    timeZone: textValue(values.time_zone),
    uses: textValue(values.uses),
    startOff: values.start_off === true,
  };
}

// --- Writing terms --------------------------------------------------------

function dollars(text: string): Money | null {
  const match = DOLLARS.exec(text.replaceAll(",", ""));
  if (!match) return null;
  return { currency: "USD", minor: String(BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))) };
}

function offsetMinutes(utc: number, timeZone: string): number {
  const parts = zoneParts(utc, timeZone);
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((wall - utc) / 60000);
}

function realDay(text: string): [number, number, number] | null {
  const match = DAY.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return [year, month, day];
}

/** The start (00:00:00) or end (23:59:59) of a calendar day in a time zone, with its UTC offset. */
export function dayBoundary(day: string, edge: "start" | "end", timeZone: string): string | null {
  const parts = realDay(day);
  if (!parts) return null;
  const [hour, minute, second] = edge === "start" ? [0, 0, 0] : [23, 59, 59];
  const wall = Date.UTC(parts[0], parts[1] - 1, parts[2], hour, minute, second);
  // Twice, so a day that starts or ends next to a daylight-saving change gets that moment's offset.
  let offset = offsetMinutes(wall, timeZone);
  offset = offsetMinutes(wall - offset * 60000, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const pad = (value: number) => String(value).padStart(2, "0");
  const size = Math.abs(offset);
  return `${day}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

function validZone(timeZone: string): boolean {
  if (!ZONE.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export type Terms = {
  code: string;
  globalCap: number;
  disabled: boolean;
  rule: Omit<Rule, "ruleId" | "version" | "startsAt"> & { startsAt?: string };
};

/**
 * Turns a draft into coupon terms, or says in plain words what to fix.
 * When editing, a day the owner did not change keeps the coupon's exact
 * time, so an edit to one term never moves another.
 */
export function termsFromDraft(draft: Draft, current?: Coupon): { terms: Terms } | { problems: string[] } {
  const problems: string[] = [];
  const code = draft.code;
  if (!code) problems.push("Enter a code.");
  else if (code.length > 100) problems.push("Keep the code to 100 characters or fewer.");

  let discount: Rule["discount"] | null = null;
  if (draft.kind === "percentage") {
    const match = PERCENT.exec(draft.percent);
    const basisPoints = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : 0;
    if (!(basisPoints > 0 && basisPoints <= 10_000)) problems.push("Enter a percent off between 0.01 and 100, such as 15 or 12.5.");
    const maximum = draft.maxDiscount ? dollars(draft.maxDiscount) : undefined;
    if (maximum === null) problems.push("Enter the most it can take off as dollars, such as 25 or 25.00, or leave it blank.");
    if (basisPoints > 0 && basisPoints <= 10_000 && maximum !== null) {
      discount = { kind: "percentage", basisPoints, ...(maximum ? { maximum } : {}) };
    }
  } else {
    const amount = dollars(draft.amount);
    if (!amount || amount.minor === "0") problems.push("Enter the dollars off, such as 5 or 12.50.");
    else discount = { kind: "fixed", amount };
  }

  const minimum = dollars(draft.minSpend || "0");
  if (!minimum) problems.push("Enter the minimum spend as dollars, such as 50, or 0 for none.");

  const products = draft.products ? [...new Set(draft.products.split(",").map(id => id.trim()).filter(Boolean))] : [];
  if (products.length > MAX_PRODUCTS) problems.push(`List at most ${MAX_PRODUCTS} product IDs.`);
  if (products.some(id => id.length > 200)) problems.push("A product ID is too long; copy it from the product's page.");

  const timeZone = draft.timeZone;
  const zoneOk = validZone(timeZone);
  if (!zoneOk) problems.push("Pick a time zone.");

  const zoneMoved = Boolean(current && current.rule.timeZone !== timeZone);
  const sameDay = (day: string, instant: string | undefined) =>
    Boolean(current && instant && !zoneMoved && day === dayIn(instant, current.rule.timeZone));
  let startsAt: string | undefined;
  if (draft.startsOn) {
    startsAt = sameDay(draft.startsOn, current?.rule.startsAt) ? current!.rule.startsAt
      : zoneOk ? dayBoundary(draft.startsOn, "start", timeZone) ?? undefined : undefined;
    if (zoneOk && !startsAt) problems.push("Pick a real first day, or leave it blank to start now.");
  } else if (current) {
    startsAt = zoneMoved && zoneOk ? dayBoundary(dayIn(current.rule.startsAt, current.rule.timeZone), "start", timeZone) ?? undefined
      : current.rule.startsAt;
  }
  let endsAt: string | null = null;
  if (!draft.endsOn) problems.push("Pick the last day shoppers can use it.");
  else if (zoneOk) {
    endsAt = sameDay(draft.endsOn, current?.rule.endsAt) ? current!.rule.endsAt : dayBoundary(draft.endsOn, "end", timeZone);
    if (!endsAt) problems.push("Pick a real last day.");
  }
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) problems.push("The last day must come after the first day.");
  if (endsAt && Date.parse(endsAt) <= Date.now() && endsAt !== current?.rule.endsAt) {
    problems.push("The last day has already passed; pick a later one.");
  }

  const uses = /^\d{1,9}$/.test(draft.uses) ? Number(draft.uses) : NaN;
  if (!(uses >= 1 && uses <= MAX_USES)) problems.push("Enter how many times the coupon can be used in total, 1 or more.");

  if (problems.length || !discount || !minimum || !endsAt) return { problems };
  return {
    terms: {
      code,
      globalCap: uses,
      disabled: draft.startOff,
      rule: {
        discount,
        appliesTo: products.length ? "selected-products" : "all-merchandise",
        selectedProductIds: products,
        includeSaleItems: draft.includeSale,
        minimumEligibleMerchandise: minimum,
        ...(startsAt ? { startsAt } : {}),
        endsAt,
        timeZone,
      },
    },
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const RULE_FIELDS = ["discount", "appliesTo", "selectedProductIds", "includeSaleItems", "minimumEligibleMerchandise",
  "startsAt", "endsAt", "timeZone"] as const;

/** Only what the owner changed, as the service's edit preview takes it; null when nothing changed. */
export function editChanges(terms: Terms, current: Coupon): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  if (terms.code !== current.code) changes.code = terms.code;
  if (terms.globalCap !== current.globalCap) changes.globalCap = terms.globalCap;
  const rule: Record<string, unknown> = {};
  for (const field of RULE_FIELDS) {
    const next = terms.rule[field];
    if (next !== undefined && !same(next, current.rule[field])) rule[field] = next;
  }
  if (Object.keys(rule).length) changes.rule = rule;
  return Object.keys(changes).length ? changes : null;
}
