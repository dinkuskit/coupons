# Coupons admin plugin

A small EmDash Registry plugin that adds a **Coupons** page to a store's
admin. Store owners list their coupons, see how many uses each has left,
create new ones, edit them, and turn them off and on. Every coupon lives in the
hosted DinkusKit coupon service ([docs/hosted-coupon-service.md](../../docs/hosted-coupon-service.md));
the plugin keeps none of its own.

It is a sandboxed plugin with no native entry. It asks for one permission:
network access to `coupons.dinkuskit.com` and no other host.

## Using it

1. Install the plugin from the EmDash plugin Registry.
2. In the plugin's settings, paste a coupon pass from your DinkusKit account
   that can manage coupons (`coupons:admin`). EmDash stores it encrypted and
   never shows it again. The pass names the store, so there is nothing else to
   set up.
3. Open **Coupons** in the admin menu.

Every change is two steps. **Preview** asks the coupon service what the
change would do and shows it, side by side with the coupon as it is now.
Nothing changes until you press the confirm button, which you must do within
five minutes. If the coupon changed in between, or another coupon took the
code, the service refuses and nothing changes. If the answer is lost on the
way back, **Check again** finishes the same change without ever making it
twice.

Days are whole days in the time zone you pick: a coupon runs from 12:00 AM on
its first day to 11:59 PM on its last day. Leave the first day blank to start
now. When editing, a day you leave alone keeps its exact time, even if the
coupon was created with another tool at a time other than midnight.

Coupons are never deleted, because a coupon's record holds the history its use
limit depends on. Turn a coupon off instead; checkouts that already applied it
keep their discount.

## Known gap: passes last an hour

The coupon service accepts a pass for one hour after it is issued, and nothing
renews a saved pass yet. Until the DinkusKit sign-in service issues coupon
passes and the plugin renews them, the page asks for a fresh pass once the
saved one is an hour old. Commerce checkout's coupon pass has the same gap.

## Development

From the repository root:

```sh
npm run typecheck      # includes the plugin against EmDash's real types
npm run test:runtime   # the plugin's screens against the real service Worker
npm run test:plugin    # the built plugin inside EmDash's sandbox runner
npm run build:plugin   # manifest check, Registry packaging, size and headroom
```

`src/plugin.ts` routes admin interactions, `src/screens.ts` builds the Block
Kit screens, `src/terms.ts` turns what the owner types into coupon terms, and
`src/service.ts` reads the pass and calls the service. The Registry allows
128 KiB per file; the built backend is about 24 KB.
