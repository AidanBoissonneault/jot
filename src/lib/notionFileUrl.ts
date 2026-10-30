/** Removes expiring credentials from Notion file URLs for stable comparisons. */
export function stableNotionFileUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('X-Amz-Signature') || url.hostname.startsWith('prod-files-secure.s3.')) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Preserve malformed values for exact comparison.
  }
  return value;
}
