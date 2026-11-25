import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../dist/plugin.mjs";
import { store } from "./store.mjs";

for (const [name, data] of [
  ["holds", { coupon: "c", cart: "cart", ref: "old" }],
  ["guesses", { wrong: 1, blocked: false }],
]) {
  for (const method of ["query", "getVersioned"]) {
    test(`sweep keeps ${name} renewed after ${method}`, async () => {
      const ctx = store();
      const collection = ctx.storage[name];
      const expired = { ...data, until: "2020-01-01T00:00:00.000Z" };
      const renewed = { ...data, until: "2099-01-01T00:00:00.000Z" };
      await collection.put("renewed", expired);
      await collection.put("expired", expired);
      const read = collection[method];
      let replaced = false;
      collection[method] = async (...args) => {
        const snapshot = await read(...args);
        if (!replaced && (method === "query" || args[0] === "renewed")) {
          await collection.put("renewed", renewed);
          replaced = true;
        }
        return snapshot;
      };

      await plugin.hooks.cron({ name: "sweep" }, ctx);
      assert.equal(replaced, true);
      assert.deepEqual(await collection.get("renewed"), renewed);
      assert.equal(await collection.get("expired"), null);
    });
  }
}
