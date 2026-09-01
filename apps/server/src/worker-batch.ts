export async function runBoundedWorkerBatch<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T,index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("worker batch concurrency must be a positive integer");
  }
  let nextIndex = 0;
  const failures: unknown[] = [];
  const workerCount = Math.min(values.length,concurrency);
  await Promise.all(Array.from({ length: workerCount },async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]!,index);
      } catch (error) {
        failures.push(error);
      }
    }
  }));
  if (failures.length) throw failures[0];
}
