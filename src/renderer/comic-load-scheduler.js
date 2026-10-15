export class ComicLoadScheduler {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
    this.active = 0;
    this.sequence = 0;
    this.queue = [];
    this.activeItems = new Set();
  }

  enqueue(task, { priority = 0, isStale = () => false, background = false } = {}) {
    const item = {
      task,
      priority: Number(priority) || 0,
      sequence: this.sequence++,
      isStale,
      background,
      controller: new AbortController(),
      resolve: null,
      reject: null,
      done: null,
      resolveDone: null,
      finished: false
    };
    item.done = new Promise((resolve) => { item.resolveDone = resolve; });
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      this.queue.push(item);
      this.pump();
    });
    return { promise, item };
  }

  cancelPending(predicate = () => true) {
    const remaining = [];
    for (const item of this.queue) {
      if (predicate(item)) {
        item.resolve(null);
        this.finish(item);
      }
      else remaining.push(item);
    }
    this.queue = remaining;
    this.pump();
  }

  cancelActive(predicate = () => true) {
    const pending = [];
    for (const item of this.activeItems) {
      if (predicate(item)) {
        item.controller.abort();
        pending.push(item.done);
      }
    }
    return Promise.allSettled(pending);
  }

  waitForIdle(predicate = () => true) {
    const pending = [
      ...this.queue.filter(predicate).map((item) => item.done),
      ...[...this.activeItems].filter(predicate).map((item) => item.done)
    ];
    return Promise.allSettled(pending);
  }

  finish(item) {
    if (item.finished) return;
    item.finished = true;
    item.resolveDone?.();
  }

  sortQueue() {
    this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
  }

  pump() {
    this.sortQueue();
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      if (item.isStale()) {
        item.resolve(null);
        this.finish(item);
        continue;
      }
      this.active += 1;
      this.activeItems.add(item);
      Promise.resolve()
        .then(() => item.task(item.controller.signal))
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeItems.delete(item);
          this.active -= 1;
          this.finish(item);
          this.pump();
        });
    }
  }
}
