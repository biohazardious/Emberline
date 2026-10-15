/**
 * Serializes async critical sections per key (e.g. one project's main workspace or roadmap file)
 * within this core process. Callers on different keys never wait for each other.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      // Drop the entry once nobody queued behind us, so the map does not grow per key forever.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** True while a critical section for `key` is running or queued. */
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
