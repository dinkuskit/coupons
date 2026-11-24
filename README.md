# coupons

`@dinkuskit/coupons` is DinkusKit Coupons, the `dinkus-coupons` EmDash
Registry plugin: discount codes shoppers type at checkout, for stores running
DinkusKit Commerce. Coupons and their uses stay in the store's own database;
there is no hosted service and nothing to sign up for.

EmDash plugins cannot call each other, so the store's own checkout code asks
Coupons for an answer and hands it to Commerce's add-ons door. Commerce keeps
setting prices and doing the totals, and checks every line again. Commerce's
paid news, carried by the store's courier, counts each use.

What a coupon can do is the set Shopify and WooCommerce share: percent off,
dollars off the order or off each item, free shipping, every product or chosen
products or categories, a minimum order amount or item count, an "exclude sale
items" box, first and last days, a total uses limit and one use per shopper.
Up to 5 money codes and 1 free shipping code combine Shopify's way.

See [how the plugin works](docs/plugin.md).

## Development

```sh
npm ci
npm run typecheck
npm test        # builds the plugin, runs the Registry packaging check, then the tests
```

The package is private at `0.0.0` until its release gates pass.

## Install type

See [what ships and where it runs](https://dinkuskit.com/docs/developers/contribute#what-ships-and-where-it-runs)
for the boundaries between Registry plugins, hosted services, the template,
the playground and developer-only test tools. Beta and stable plugin artifacts
do not include those developer preview controls.

DinkusKit plugins ship as EmDash Registry plugins: sandboxed and installed
from the plugin Registry, which is how most EmDash sites add plugins. The
Registry build is the supported product, and features are designed, tested and
documented for it first. A native entry (code a site registers in its own
configuration or Astro routes) is a developer and test setup only. It may not
offer features the Registry build lacks, except temporary gaps listed here with
the work that closes them. The project owner set this rule on 2026-10-08.

The Coupons plugin ships as a Registry plugin, as the Agent Contract
requires (sandboxed, with no native escape). It has no native entry.
