// What the accepted codes take off each checkout line, worked out the way Shopify does for stores without
// Shopify Plus (coupons-combining-20261124): product discounts first, and only the best one on any one line; then
// order discounts, each on the subtotal left after product discounts; then free shipping. Whole cents only, and
// no line ever goes below $0 (coupons-audit-requirements-20261124). Plain data: no storage.
import { kindOf, type Coupon } from "./terms.js";

/** A checkout line as the store's code hands it over, in Commerce's line order. */
export interface Line {
  item: string;
  /** The catalog product the item belongs to (the item itself for a product without options). */
  product: string;
  /** The unit price Commerce charges now, in whole cents. */
  price: string;
  quantity: number;
  /** Whether the item is on sale now. */
  sale: boolean;
  /** The product's category slugs. */
  categories: string[];
}

export const subtotalOf = (line: Line) => BigInt(line.price) * BigInt(line.quantity);

/** Whether a coupon's money off can reach this line. */
export function eligible(coupon: Coupon, line: Line): boolean {
  if (coupon.excludeSale && line.sale) return false;
  if (coupon.appliesTo === "products") return coupon.ids.includes(line.product) || coupon.ids.includes(line.item);
  if (coupon.appliesTo === "categories") return line.categories.some(slug => coupon.ids.includes(slug));
  return true;
}

/** Why a coupon gives nothing to these lines, or null when it applies. */
export function unmet(coupon: Coupon, lines: readonly Line[]): "no_items" | "minimum" | null {
  const reach = coupon.amount.type === "none" ? lines : lines.filter(line => eligible(coupon, line));
  if (!reach.length) return "no_items";
  const min = coupon.minimum;
  if (min.type === "amount" && reach.reduce((sum, line) => sum + subtotalOf(line), 0n) < BigInt(min.cents)) return "minimum";
  if (min.type === "items" && reach.reduce((sum, line) => sum + line.quantity, 0) < min.count) return "minimum";
  return null;
}

/** Splits a total over lines by weight, largest remainders first, never more than a line's weight. */
export function spread(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n || total <= 0n) return weights.map(() => 0n);
  const capped = total > sum ? sum : total;
  const parts = weights.map(weight => capped * weight / sum);
  let left = capped - parts.reduce((a, b) => a + b, 0n);
  const order = weights.map((weight, index) => ({ index, rest: capped * weight % sum })).sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  for (const { index } of order) {
    if (left === 0n) break;
    if (parts[index]! < weights[index]!) { parts[index]! += 1n; left -= 1n; }
  }
  return parts;
}

const percentOf = (amount: bigint, basisPoints: number) => (amount * BigInt(basisPoints) + 5_000n) / 10_000n;

/** What one coupon would take off each line from these amounts, on its own. */
function offs(coupon: Coupon, lines: readonly Line[], from: readonly bigint[]): bigint[] {
  const amount = coupon.amount;
  const weights = lines.map((line, index) => (eligible(coupon, line) ? from[index]! : 0n));
  if (amount.type === "percent") return weights.map(weight => percentOf(weight, amount.basisPoints));
  if (amount.type === "each") return weights.map((weight, index) => (weight ? BigInt(amount.cents) * BigInt(lines[index]!.quantity) : 0n)).map((off, index) => (off > weights[index]! ? weights[index]! : off));
  if (amount.type === "order") return spread(BigInt(amount.cents), weights);
  return lines.map(() => 0n);
}

export interface Priced {
  /** The amount off each line, from all coupons. */
  lines: bigint[];
  /** The amount each coupon took off, in the order given. */
  byCoupon: bigint[];
  freeShipping: boolean;
}

/** The accepted coupons, in the order the shopper typed them, applied to the lines. */
export function price(coupons: readonly Coupon[], lines: readonly Line[]): Priced {
  const subtotals = lines.map(subtotalOf);
  const byCoupon = coupons.map(() => 0n);
  const off = lines.map(() => 0n);
  // Product discounts: each line takes the best one; on a tie, the code typed first.
  const product = coupons.map((coupon, index) => ({ coupon, index })).filter(({ coupon }) => kindOf(coupon) === "product");
  const productOffs = product.map(({ coupon }) => offs(coupon, lines, subtotals));
  lines.forEach((_line, at) => {
    let best = -1;
    productOffs.forEach((amounts, which) => { if (amounts[at]! > 0n && (best < 0 || amounts[at]! > productOffs[best]![at]!)) best = which; });
    if (best >= 0) { off[at] = productOffs[best]![at]!; byCoupon[product[best]!.index]! += off[at]!; }
  });
  // Order discounts: each on what product discounts left, all added up, and never past a line's last cent.
  const left = subtotals.map((subtotal, at) => subtotal - off[at]!);
  coupons.forEach((coupon, index) => {
    if (kindOf(coupon) !== "order") return;
    offs(coupon, lines, left).forEach((amount, at) => {
      const room = subtotals[at]! - off[at]!, taken = amount > room ? room : amount;
      off[at]! += taken;
      byCoupon[index]! += taken;
    });
  });
  return { lines: off, byCoupon, freeShipping: coupons.some(coupon => coupon.freeShipping) };
}
