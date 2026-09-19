import { randomUUID } from "node:crypto";

export function createReaderCapabilityAuthority({ now = Date.now, ttlMs = 60_000 } = {}) {
  const capabilities = new Map();

  return {
    issue(subject, turnId) {
      const capability = randomUUID();
      capabilities.set(capability, { subject: { ...subject }, turnId, expiresAt: now() + ttlMs });
      return capability;
    },
    resolve(capability, subject) {
      const record = capabilities.get(capability);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        capabilities.delete(capability);
        return null;
      }
      if (!sameSubject(record.subject, subject)) return null;
      capabilities.delete(capability);
      return { ...record.subject };
    },
    revokeTurn(turnId) {
      for (const [capability, record] of capabilities) {
        if (record.turnId === turnId) capabilities.delete(capability);
      }
    },
    clear() {
      capabilities.clear();
    },
  };
}

function sameSubject(left, right) {
  return left?.adapter === right?.adapter
    && left?.requester === right?.requester
    && left?.channel === right?.channel
    && left?.thread === right?.thread;
}
