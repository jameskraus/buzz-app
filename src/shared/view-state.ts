// View intent is durable and explicitly partitioned; connection generations are not storage keys.
export function readView<T>(scope: string, key: string, fallback: T): T {
  try {
    return (
      JSON.parse(
        localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`) ??
          "null",
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function writeView(scope: string, key: string, value: unknown) {
  try {
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([scope, key])}`,
      JSON.stringify(value),
    );
  } catch {
    /* Keep the in-memory editor usable when browser storage is unavailable. */
  }
}

/** Forgets every key saved under one scope, for a community the viewer has left. */
export function clearViewScope(scope: string) {
  const prefix = `buzz-view.v1:${JSON.stringify([scope]).slice(0, -1)},`;
  const stale: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

/** Recovery callers must confirm cleanup before retiring their durable operation. */
export function clearView(scope: string, ...keys: string[]) {
  for (const key of keys) {
    const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
    localStorage.removeItem(storageKey);
    if (localStorage.getItem(storageKey) !== null)
      throw new Error("Could not clear the saved message. Try again.");
  }
}
