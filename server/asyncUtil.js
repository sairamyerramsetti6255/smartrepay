/** Yield so Express can handle other API requests during long CPU/DB work. */
export function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}
