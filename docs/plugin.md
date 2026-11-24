# How the Coupons plugin works

DinkusKit Coupons is the `dinkus-coupons` EmDash Registry plugin. The owner
approved the design on 24 Nov 2026 (GrillTrack `coupons-plugin-home-20261124`,
`coupons-v1-settings-20261124`, `coupons-combining-20261124`,
`coupons-hold-20261124`, `coupons-guessing-20261124`,
`coupons-agent-tools-20261124` and `coupons-audit-requirements-20261124`).

## The path of a code

EmDash plugins cannot call each other, so the store carries the answer:

1. The shopper types codes in the box on the store's `/checkout` page, a plain
   form with no script.
2. The store's own server code reads the cart's lines from Commerce, in
   Commerce's line order (cart lines sorted by catalog item id), and asks
   `POST checkout/answer` with nobody signed in.
3. When the shopper goes to pay, it asks again with `hold: true` and hands the
   `answer` to Commerce's private add-ons door, `checkout/addons/start`.
   Commerce checks every line's item and unit price again, does the totals and
   keeps `{ from, ref, codes }` on the order.
4. Commerce's `order.paid` news, carried by the store's courier, names the
   order's add-ons. Coupons counts one use per order and coupon and drops the
   hold.

## `POST checkout/answer`

Private (`plugins:manage`). A call with a signed-in person is refused with
`STORE_ONLY`, so only the store's own code can use it. Unknown keys and values
out of bounds are refused with `BAD_REQUEST`.

| Field | Meaning | Bound |
| --- | --- | --- |
| `cart` | the cart's key; kept only as a one-way hash | 1 to 200 characters |
| `connection` | the shopper's connection, such as the IP address; kept only as a one-way hash for an hour | 1 to 200, optional |
| `email` | the order email, for one use per shopper; kept only as a one-way hash | optional |
| `codes` | what the shopper typed; not case-sensitive | at most 6, each 1 to 64 |
| `lines` | `[{ item, product?, price, quantity, sale?, categories? }]`, every checkout line in Commerce's order | 1 to 100 |
| `hold` | `true` when checkout starts | optional |

`price` is the unit price in whole cents as a string, at most 1,000,000,000.
`product` is the catalog product an item belongs to (the item itself when
left out); `categories` are the product's category slugs; `sale` says whether
the item is on sale now.

The answer is `{ codes, answer }`. `codes` has one entry per different code,
in the order typed: `{ code, ok: true, off, freeShipping }` or
`{ code, ok: false, reason, message }`, where `message` is what to show the
shopper. `answer` is what goes to Commerce unchanged, or `null` when no code
applies:

```json
{ "from": "dinkus-coupons", "ref": "h_….c_…", "codes": ["SPRING25"], "ship": "free",
  "lines": [{ "item": "boots", "price": "8000", "off": "2000" }] }
```

`ref` is present only with `hold`. Reasons: `not_found` (also a turned-off
code, answered exactly the same way), `not_started`, `expired`, `minimum`,
`no_items`, `used_up`, `used_by_you`, `not_combinable` and `try_later`.

## `POST checkout/release`

`{ cart }`, store code only. The payment page closed without a payment, so the
cart's held uses go back. Holds lapse on their own after 60 minutes.

## The rules

- **Discount:** percent off; dollars off the order, spread over the lines it
  reaches by price; dollars off each item; free shipping, alone or with money
  off. Whole cents; no line ever goes below $0.
- **Applies to:** every product, chosen products or chosen categories, at most
  100 ids of at most 200 characters. Sale items are discounted unless "Don't
  discount items already on sale" is on.
- **Minimum:** an order amount or a number of items, counted on the lines the
  coupon reaches.
- **Dates:** a first and last day in the store's time zone, set on the
  Coupons page (Eastern until changed): 12:00 AM to 11:59 PM.
- **Uses:** a total limit across all shoppers, and one use per shopper by
  order email. A checkout holds a use while the shopper pays. A payment that
  arrives after its hold lapsed still counts, even over the limit. Test orders
  are kept but never count.
- **Combining (Shopify's rule, without Shopify Plus):** each coupon is a
  product discount (chosen products or categories, or dollars off each item),
  an order discount (the whole order) or a shipping discount (free shipping
  only). Two codes go together only when each one's "Combines with" box
  allows the other's class. At most 5 product or order codes and 1 shipping
  code. Product discounts apply first, and only the best one on any one line;
  order discounts each apply to what product discounts left, and are added
  up; free shipping comes last.
- **Guessing:** after 10 wrong codes on one cart, or 50 from one connection,
  that cart or connection waits an hour before another code is checked.
- **Edits:** an edit keeps the coupon's id and bumps its version. Checkouts
  already started keep the terms they were priced with, because Commerce froze
  them.

## The courier inbox

`POST courier/inbox` follows dinkuskit/courier's door rules: `wants` asks
Commerce (`dinkus-commerce`) for `order.paid`, 50 at a time; `deliver` counts
each order whose `addons` include `dinkus-coupons`. The ref names the coupons
it held, so a rename after checkout never loses a use. The bookmark moves only
after the uses are saved.

## The owner's page and agent tools

The Coupons page (Administrators) lists coupons with their uses, creates and
edits them, and turns them on and off; it warns when the courier has not come
by, because uses are counted only then. EmDash's agent tools
`list_coupons`, `get_coupon`, `save_coupon` and `turn_coupon` use private
routes with the same permission and take the same field names as the form.

A timer every 15 minutes deletes ended holds and finished guess counts, so a
store's history stays bounded: one row per coupon, one per paid use, and short-
lived holds and guess counts.
