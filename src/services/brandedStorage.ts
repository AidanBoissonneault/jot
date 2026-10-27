/** Reads a renamed browser-storage value and copies it forward without deleting the old key. */
export async function getBrandedStorageValue<Value>(
  key: string,
  legacyKey: string,
): Promise<Value | undefined> {
  const stored = await browser.storage.local.get([key, legacyKey]);
  const current = stored[key] as Value | undefined;
  if (current !== undefined) return current;

  const legacy = stored[legacyKey] as Value | undefined;
  if (legacy !== undefined) {
    await browser.storage.local.set({ [key]: legacy });
  }
  return legacy;
}
