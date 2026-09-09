/**
 * Run `worker` over `items` with a bounded number of in-flight promises.
 *
 * This replaces the sequential `foreach` loop in manager.cs STEP 3. Instead of
 * awaiting each borrower one at a time, up to `limit` borrowers are processed
 * concurrently while keeping memory and socket usage under control.
 *
 * Each result is `{ ok: true, value }` or `{ ok: false, error }` so a single
 * failing borrower never aborts the whole run (fault isolation).
 */
export async function mapWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length)
  let nextIndex = 0
  let completed = 0

  async function runner() {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await worker(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
      completed++
      onProgress?.(completed, items.length)
    }
  }

  const poolSize = Math.min(Math.max(1, limit), items.length || 1)
  await Promise.all(Array.from({ length: poolSize }, runner))
  return results
}

/** Split an array into fixed-size chunks. */
export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
