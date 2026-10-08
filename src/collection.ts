import type { CouponCollection, CouponRecord } from "./core.js";

/**
 * Commerce's coupon core stores each coupon, with its redemption attempts, as
 * one record in an EmDash storage collection. This is the same collection
 * contract over one store's Durable Object SQLite database.
 *
 * Every call is synchronous SQL inside the Durable Object, so nothing else in
 * the store interleaves between a read and the compare-and-set that follows.
 * `normalized_code` is UNIQUE, matching Commerce's `uniqueIndexes`.
 */
export const COUPON_TABLES = [
  `CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,
    normalized_code TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    value TEXT NOT NULL
  )`,
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  revision: number;
  value: string;
}

function code(record: CouponRecord): string {
  if (typeof record?.normalizedCode !== "string" || record.normalizedCode === "") {
    throw new Error("coupon record has no normalizedCode");
  }
  return record.normalizedCode;
}

export function createSqlCouponCollection(sql: SqlStorage): CouponCollection {
  const read = (id: string): Row | undefined =>
    sql.exec<Row>("SELECT id, revision, value FROM coupons WHERE id = ?", id).toArray()[0];

  return {
    async get(id) {
      const row = read(id);
      return row ? (JSON.parse(row.value) as CouponRecord) : null;
    },

    async getVersioned(id) {
      const row = read(id);
      return row ? { value: JSON.parse(row.value) as CouponRecord, revision: String(row.revision) } : null;
    },

    async put(id, data) {
      sql.exec(
        `INSERT INTO coupons (id, normalized_code, revision, value) VALUES (?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET normalized_code = excluded.normalized_code,
           revision = coupons.revision + 1, value = excluded.value`,
        id, code(data), JSON.stringify(data),
      );
    },

    async compareAndSet(id, expectedRevision, data) {
      if (expectedRevision === null) {
        if (read(id)) return { applied: false };
        sql.exec("INSERT INTO coupons (id, normalized_code, revision, value) VALUES (?, ?, 1, ?)", id, code(data), JSON.stringify(data));
        return { applied: true, revision: "1" };
      }
      const expected = Number(expectedRevision);
      if (!Number.isSafeInteger(expected)) return { applied: false };
      // RETURNING, not rowsWritten: rowsWritten also counts index writes.
      const updated = sql.exec<{ revision: number }>(
        "UPDATE coupons SET normalized_code = ?, revision = revision + 1, value = ? WHERE id = ? AND revision = ? RETURNING revision",
        code(data), JSON.stringify(data), id, expected,
      ).toArray()[0];
      return updated ? { applied: true, revision: String(updated.revision) } : { applied: false };
    },

    async query(options = {}) {
      const where = options.where ?? {};
      const keys = Object.keys(where);
      if (keys.some(key => key !== "normalizedCode") || (keys.length === 1 && typeof where.normalizedCode !== "string")) {
        throw new Error("coupon queries support only an exact normalizedCode filter");
      }
      if (options.orderBy !== undefined) throw new Error("coupon queries are ordered by id only");
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const after = options.cursor ?? "";
      const rows = keys.length === 1
        ? sql.exec<Row>(
          "SELECT id, revision, value FROM coupons WHERE normalized_code = ? AND id > ? ORDER BY id LIMIT ?",
          where.normalizedCode as string, after, limit + 1,
        ).toArray()
        : sql.exec<Row>("SELECT id, revision, value FROM coupons WHERE id > ? ORDER BY id LIMIT ?", after, limit + 1).toArray();
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        items: page.map(row => ({ id: row.id, data: JSON.parse(row.value) as CouponRecord })),
        hasMore,
        ...(hasMore ? { cursor: page[page.length - 1]!.id } : {}),
      };
    },
  };
}
