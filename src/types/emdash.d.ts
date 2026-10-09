// Commerce's coupon core imports only types from "emdash". The service never
// loads EmDash, so typecheck resolves those imports here. StorageCollection and
// its result types are copied from emdash@1.2.0 (the version Commerce pins);
// host-only types the coupon core never reaches at runtime stay opaque.

export interface RangeFilter {
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
}
export interface InFilter {
  in: Array<string | number>;
}
export interface StartsWithFilter {
  startsWith: string;
}
export type WhereValue = string | number | boolean | null | RangeFilter | InFilter | StartsWithFilter;
export type WhereClause = Record<string, WhereValue>;
export interface QueryOptions {
  where?: WhereClause;
  orderBy?: Record<string, "asc" | "desc">;
  /** Default 50, max 100 */
  limit?: number;
  cursor?: string;
}
export interface PaginatedResult<T> {
  items: T[];
  cursor?: string;
  hasMore: boolean;
}
export interface VersionedValue<T = unknown> {
  value: T;
  revision: string;
}
export type ConditionalWriteResult = { applied: true; revision: string } | { applied: false };
export interface ConditionalDeleteResult {
  applied: boolean;
}
export interface StorageCollection<T = unknown> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  getVersioned(id: string): Promise<VersionedValue<T> | null>;
  compareAndSet(id: string, expectedRevision: string | null, data: T): Promise<ConditionalWriteResult>;
  compareAndDelete(id: string, expectedRevision: string): Promise<ConditionalDeleteResult>;
  getMany(ids: string[]): Promise<Map<string, T>>;
  putMany(items: Array<{ id: string; data: T }>): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  query(options?: QueryOptions): Promise<PaginatedResult<{ id: string; data: T }>>;
  count(where?: WhereClause): Promise<number>;
  updateIf(id: string, args: unknown): Promise<unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PluginContext = any;
export type PluginRoute = any;
export type CronEvent = any;
