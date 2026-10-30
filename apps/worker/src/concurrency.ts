/** Runs asynchronous work with a concurrency limit and preserves input order. */
export async function mapWithConcurrency<Input, Output>(
  values: Input[],
  limit: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await map(values[index], index);
    }
  }));

  return results;
}
