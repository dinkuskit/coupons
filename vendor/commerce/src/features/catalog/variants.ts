import { CatalogError } from "./errors.js";
import { createCatalogItem } from "./create-catalog-item.js";
import type {
  CatalogFulfillment, CatalogItemRecord, CatalogStorageRecord, CatalogVariantMember,
  CatalogVariantOption, CatalogVariantOptionValue, CatalogVariantProduct, CatalogVariantSelection,
} from "./types.js";

export type { CatalogVariantMember, CatalogVariantOption, CatalogVariantOptionValue, CatalogVariantProduct } from "./types.js";
export interface CatalogVariantStorage { catalog: {
  get(id: string): Promise<CatalogStorageRecord | null>;
  getVersioned(id: string): Promise<{ value: CatalogStorageRecord; revision: string } | null>;
  compareAndSet(id: string, revision: string, value: CatalogStorageRecord): Promise<{ applied: boolean }>;
} }
export interface VariantMemberInput { catalogItemId?: string; commandId?: string; name?: string; sku?: string; fulfillment: CatalogFulfillment }
export interface AddCatalogVariantOptionInput {
  productId: string; optionId: string; optionLabel: string;
  values: readonly { valueId: string; label: string; member: VariantMemberInput }[];
}
export interface UpdateCatalogVariantLabelsInput {
  productId: string; expectedRevision: number; optionLabel?: string;
  values: readonly { valueId: string; label: string }[];
  members?: readonly { catalogItemId: string; fulfillment: CatalogFulfillment }[];
}
export interface CatalogVariantResolution { item: CatalogItemRecord; product: CatalogVariantProduct | null; member: CatalogVariantMember | null }

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const id = (v: unknown, field: string) => {
  if (typeof v !== "string" || !ID.test(v)) throw new CatalogError("INVALID_INPUT", `invalid ${field}`);
  return v;
};
const text = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > 160) throw new CatalogError("INVALID_INPUT", `${field} must be a non-empty string`);
  return v.normalize("NFKC").trim();
};
const fill = (v: unknown): CatalogFulfillment => {
  if (v !== "physical" && v !== "digital") throw new CatalogError("INVALID_INPUT", "fulfillment must be physical or digital");
  return v;
};
const key = (s: readonly CatalogVariantSelection[]) =>
  JSON.stringify([...s].sort((a, b) => `${a.optionId}:${a.valueId}`.localeCompare(`${b.optionId}:${b.valueId}`)));
const same = (a: readonly CatalogVariantSelection[], b: readonly CatalogVariantSelection[]) => key(a) === key(b);
const payload = (v: unknown) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

function valid(raw: unknown, productId: string): CatalogVariantProduct {
  const p = raw as CatalogVariantProduct;
  if (!p || typeof p !== "object" || p.schema !== "dinkuskit.commerce.product-variants/v1" ||
      p.productId !== productId || !Number.isSafeInteger(p.revision) || p.revision < 0 ||
      !Array.isArray(p.options) || !Array.isArray(p.members) || !ID.test(p.defaultMemberId)) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "stored variant product is invalid");
  }
  const options = new Set<string>();
  for (const o of p.options) {
    if (!o || !ID.test(o.optionId) || options.has(o.optionId) || !o.label || !Array.isArray(o.values))
      throw new CatalogError("STORAGE_UNAVAILABLE", "stored variant options are invalid");
    options.add(o.optionId);
    const values = new Set<string>();
    for (const v of o.values) {
      if (!v || !ID.test(v.valueId) || !v.label || values.has(v.valueId))
        throw new CatalogError("STORAGE_UNAVAILABLE", "stored variant values are invalid");
      values.add(v.valueId);
    }
  }
  const members = new Set<string>(), combinations = new Set<string>();
  for (const m of p.members) {
    if (!m || !ID.test(m.catalogItemId) || members.has(m.catalogItemId) || !Array.isArray(m.selections) ||
        !["physical", "digital"].includes(m.fulfillment)) throw new CatalogError("STORAGE_UNAVAILABLE", "stored variant members are invalid");
    members.add(m.catalogItemId);
    const selected = new Set<string>();
    for (const s of m.selections) {
      const o = p.options.find(x => x.optionId === s.optionId);
      if (!o || selected.has(s.optionId) || !o.values.some((v: CatalogVariantOptionValue) => v.valueId === s.valueId))
        throw new CatalogError("STORAGE_UNAVAILABLE", "variant selection is invalid");
      selected.add(s.optionId);
    }
    if (selected.size !== p.options.length || combinations.has(key(m.selections)))
      throw new CatalogError("STORAGE_UNAVAILABLE", "duplicate variant combinations are invalid");
    combinations.add(key(m.selections));
  }
  if (p.defaultMemberId !== productId || !members.has(productId)) throw new CatalogError("STORAGE_UNAVAILABLE", "variant default member is invalid");
  return p;
}

function member(item: CatalogItemRecord): CatalogVariantMember | null {
  return item.variantProductId && item.variantSelections && item.variantFulfillment
    ? { catalogItemId: item.itemId, selections: item.variantSelections, fulfillment: item.variantFulfillment } : null;
}

export async function resolveCatalogVariantMember(
  catalog: Pick<CatalogVariantStorage["catalog"], "get">, catalogItemId: string,
): Promise<CatalogVariantResolution | null> {
  const raw = await catalog.get(catalogItemId);
  if (!raw || raw.recordKind !== "catalog-item" || raw.itemId !== catalogItemId) return null;
  const item = raw as CatalogItemRecord;
  if (!item.variantProductId) {
    if (item.variantProduct) {
      const product = valid(item.variantProduct, item.itemId);
      const found = product.members.find(m => m.catalogItemId === item.itemId) ?? null;
      return found ? { item, product, member: found } : null;
    }
    if (item.variantSelections || item.variantFulfillment) throw new CatalogError("STORAGE_UNAVAILABLE", "variant member linkage is incomplete");
    return { item, product: null, member: null };
  }
  const parent = await catalog.get(item.variantProductId);
  if (!parent || parent.recordKind !== "catalog-item" || parent.itemId !== item.variantProductId || !parent.variantProduct) return null;
  const product = valid(parent.variantProduct, item.variantProductId);
  const found = product.members.find(m => m.catalogItemId === item.itemId) ?? null;
  return found && same(found.selections, item.variantSelections ?? [])
    ? { item, product, member: found } : null;
}

export async function addCatalogVariantOption(
  storage: CatalogVariantStorage, raw: AddCatalogVariantOptionInput,
  options: { createId?: () => string; now?: () => Date; collection?: string; pluginId?: string } = {},
): Promise<{ changed: boolean; product: CatalogVariantProduct }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CatalogError("INVALID_INPUT", "variant input must be an object");
  const productId = id(raw.productId, "productId");
  const parent = await storage.catalog.getVersioned(productId);
  if (!parent || parent.value.recordKind !== "catalog-item" || parent.value.itemId !== productId)
    throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "product was not found");
  const current = (parent.value as CatalogItemRecord).variantProduct;
  if (current) {
    const p = valid(current, productId);
    const empty = !p.options.length && p.members.length === 1 && p.defaultMemberId === productId && !p.members[0].selections.length;
    if (!empty) return p.creationPayload === payload(raw) ? { changed: false, product: p } : (() => { throw new CatalogError("COMMAND_CONFLICT", "variant choices already exist; reload before editing"); })();
  }
  if (!Array.isArray(raw.values) || raw.values.length < 2 || raw.values.length > 50 ||
      !raw.values[0]?.member || raw.values[0].member.catalogItemId !== productId)
    throw new CatalogError("INVALID_INPUT", "a variant choice needs two to fifty values and must preserve the default member");
  const optionId = id(raw.optionId, "optionId"), values: CatalogVariantOptionValue[] = [], members: CatalogVariantMember[] = [], seen = new Set<string>();
  for (const [i, input] of raw.values.entries()) {
    if (!input || !input.member || typeof input.member !== "object") throw new CatalogError("INVALID_INPUT", "variant member is required");
    if (i > 0 && input.member.catalogItemId !== undefined) throw new CatalogError("INVALID_INPUT", "only the permanent default item may be reused");
    const valueId = id(input.valueId, "valueId");
    if (seen.has(valueId)) throw new CatalogError("INVALID_INPUT", "duplicate variant values are invalid");
    seen.add(valueId);
    const f = fill(input.member.fulfillment), memberId = input.member.catalogItemId
      ? id(input.member.catalogItemId, "catalogItemId")
      : (input.member.commandId && input.member.name && input.member.sku
        ? (await createCatalogItem(storage.catalog as never, { commandId: input.member.commandId, name: input.member.name, sku: input.member.sku, fulfillment: f }, {
          ...options, variantMember: { productId, selections: [{ optionId, valueId }], fulfillment: f },
        })).item.itemId : "");
    if (!memberId || (i === 0 && memberId !== productId) || (i > 0 && memberId === productId))
      throw new CatalogError("INVALID_INPUT", "only the permanent default item may be reused");
    values.push({ valueId, label: text(input.label, "value label") });
    members.push({ catalogItemId: memberId, selections: [{ optionId, valueId }], fulfillment: f });
  }
  const product: CatalogVariantProduct = {
    creationPayload: payload(raw), schema: "dinkuskit.commerce.product-variants/v1", productId,
    revision: current ? current.revision + 1 : 1, defaultMemberId: productId,
    options: [{ optionId, label: text(raw.optionLabel, "option label"), values }], members,
  };
  valid(product, productId);
  const committed = await storage.catalog.compareAndSet(productId, parent.revision, { ...(parent.value as CatalogItemRecord), variantProduct: product });
  if (!committed.applied) throw new CatalogError("STORAGE_UNAVAILABLE", "variant membership changed concurrently");
  return { changed: true, product };
}

export async function updateCatalogVariantLabels(storage: CatalogVariantStorage, raw: UpdateCatalogVariantLabelsInput) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CatalogError("INVALID_INPUT", "variant input must be an object");
  const productId = id(raw.productId, "productId");
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0 || !Array.isArray(raw.values) || (raw.members !== undefined && !Array.isArray(raw.members)))
    throw new CatalogError("INVALID_INPUT", "invalid variant label update");
  const parent = await storage.catalog.getVersioned(productId);
  if (!parent || parent.value.recordKind !== "catalog-item" || !parent.value.variantProduct) throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "product has no variant choices");
  const p = valid(parent.value.variantProduct, productId);
  if (p.revision !== raw.expectedRevision) throw new CatalogError("COMMAND_CONFLICT", "variant choices changed; reload before editing");
  const labels = new Map(raw.values.map(v => [id(v.valueId, "valueId"), text(v.label, "value label")]));
  if (labels.size !== raw.values.length || [...labels.keys()].some(k => !p.options.some(o => o.values.some(v => v.valueId === k))))
    throw new CatalogError("INVALID_INPUT", "unknown or duplicate value");
  const fulfillment = new Map((raw.members ?? []).map(m => [id(m.catalogItemId, "catalogItemId"), fill(m.fulfillment)]));
  if (fulfillment.size !== (raw.members?.length ?? 0) || [...fulfillment.keys()].some(k => !p.members.some(m => m.catalogItemId === k)))
    throw new CatalogError("INVALID_INPUT", "unknown or duplicate member");
  const next = { ...p, revision: p.revision + 1, options: p.options.map((o, i) => ({
    ...o, ...(i === 0 && raw.optionLabel !== undefined ? { label: text(raw.optionLabel, "option label") } : {}),
    values: o.values.map(v => labels.has(v.valueId) ? { ...v, label: labels.get(v.valueId)! } : v),
  })), members: p.members.map(m => ({ ...m, fulfillment: fulfillment.get(m.catalogItemId) ?? m.fulfillment })) };
  if (!(await storage.catalog.compareAndSet(productId, parent.revision, { ...(parent.value as CatalogItemRecord), variantProduct: next })).applied)
    throw new CatalogError("STORAGE_UNAVAILABLE", "variant labels changed concurrently");
  return { changed: true, product: next };
}

export function variantSelections(product: CatalogVariantProduct, member: CatalogVariantMember) {
  return member.selections.map(s => {
    const option = product.options.find(o => o.optionId === s.optionId), value = option?.values.find(v => v.valueId === s.valueId);
    if (!option || !value) throw new CatalogError("STORAGE_UNAVAILABLE", "variant selection is invalid");
    return { optionId: option.optionId, optionLabel: option.label, valueId: value.valueId, valueLabel: value.label };
  });
}
