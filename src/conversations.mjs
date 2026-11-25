/**
 * Per-client-conversation upstream thread state. Claude Code resends the full
 * transcript every turn; we keep the prefix we already forwarded and send only
 * the new tail, which also avoids refilling the upstream 64 KiB frame budget.
 */
export class ConversationStore {
  constructor({ ttlMs = 30 * 60 * 1000, max = 256 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }

  getOrCreate(key) {
    this.prune();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.max) {
        let oldestKey = null;
        let oldest = Infinity;
        for (const [k, v] of this.entries) {
          if (v.updatedAt < oldest) {
            oldest = v.updatedAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.entries.delete(oldestKey);
      }
      entry = {
        threadId: '',
        accountId: '',
        messages: [],
        instructionsHash: '',
        toolsHash: '',
        updatedAt: Date.now(),
        chain: Promise.resolve(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.updatedAt < cutoff) this.entries.delete(k);
    }
  }

  reset(entry) {
    entry.threadId = '';
    entry.accountId = '';
    entry.messages = [];
    entry.instructionsHash = '';
    entry.toolsHash = '';
  }

  /** Serialize requests for one conversation without blocking unrelated ones. */
  async lock(key) {
    const entry = this.getOrCreate(key);
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const previous = entry.chain;
    entry.chain = previous.then(() => current);
    await previous;
    entry.updatedAt = Date.now();
    return { entry, release: () => release() };
  }
}

/** True when `stored` is a prefix of `messages` (both normalized). */
export function isPrefix(stored, messages) {
  if (!Array.isArray(stored) || stored.length === 0 || messages.length <= stored.length) return false;
  for (let i = 0; i < stored.length; i++) {
    if (JSON.stringify(stored[i]) !== JSON.stringify(messages[i])) return false;
  }
  return true;
}
