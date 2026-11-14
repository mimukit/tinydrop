// Sends the writes for one bookmark in the order they were made. The screens change
// the store before the server answers, so a second write can start while the
// first is still out. Without the queue, the server could get them out of order.
export class WriteQueue {
  private tails = new Map<string, Promise<unknown>>();
  private counts = new Map<string, number>();

  /** Runs `fn` after every earlier write for `key` settles, whatever their result. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.runAll([key], fn);
  }

  /**
   * Runs `fn` after every earlier write for each of `keys` settles, whatever their result. A bulk
   * call uses one key per bookmark ID, so it waits for each bookmark's earlier writes and a later
   * write to any of them waits for it.
   */
  runAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const earlier = unique.map((key) => (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined));
    const result = Promise.all(earlier).then(fn);
    for (const key of unique) {
      this.tails.set(key, result);
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      const done = () => {
        const left = (this.counts.get(key) ?? 1) - 1;
        if (left > 0) this.counts.set(key, left);
        else {
          this.counts.delete(key);
          this.tails.delete(key);
        }
      };
      result.then(done, done);
    }
    return result;
  }

  /** The writes for `key` that have not settled yet, including one that runs now. */
  pending(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
