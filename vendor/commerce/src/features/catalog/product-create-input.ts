export function catalogProductCreateInput(
  name: string,
  sku: string,
  commandId: string,
): { commandId: string; name: string; sku: string } {
  return { commandId, name, sku };
}
