import assert from "node:assert/strict";
import test from "node:test";
import { createReaderCapabilityAuthority } from "../src/reader-capabilities.mjs";

const subject = (overrides = {}) => ({
  adapter: "slack",
  requester: "U1",
  channel: "C1",
  thread: "T1",
  ...overrides,
});

test("resolves a matching live capability once", () => {
  const authority = createReaderCapabilityAuthority({ now: () => 1_000 });
  const capability = authority.issue(subject(), "turn-1");

  assert.deepEqual(authority.resolve(capability, subject()), subject());
  assert.equal(authority.resolve(capability, subject()), null);
});

test("denies expired and mismatched capabilities without consuming a valid token", () => {
  let now = 1_000;
  const authority = createReaderCapabilityAuthority({ now: () => now, ttlMs: 100 });
  const capability = authority.issue(subject(), "turn-1");

  assert.equal(authority.resolve(capability, subject({ thread: "T2" })), null);
  assert.deepEqual(authority.resolve(capability, subject()), subject());

  const expired = authority.issue(subject(), "turn-2");
  now += 100;
  assert.equal(authority.resolve(expired, subject()), null);
});

test("isolates same-channel turns and revokes only their own capabilities", () => {
  const authority = createReaderCapabilityAuthority({ now: () => 1_000 });
  const first = authority.issue(subject({ thread: "T1" }), "turn-1");
  const second = authority.issue(subject({ thread: "T2" }), "turn-2");

  assert.equal(authority.resolve(first, subject({ thread: "T2" })), null);
  authority.revokeTurn("turn-1");
  assert.equal(authority.resolve(first, subject({ thread: "T1" })), null);
  assert.deepEqual(authority.resolve(second, subject({ thread: "T2" })), subject({ thread: "T2" }));
});

test("clears all outstanding capabilities", () => {
  const authority = createReaderCapabilityAuthority({ now: () => 1_000 });
  const first = authority.issue(subject(), "turn-1");
  const second = authority.issue(subject({ thread: "T2" }), "turn-2");

  authority.clear();

  assert.equal(authority.resolve(first, subject()), null);
  assert.equal(authority.resolve(second, subject({ thread: "T2" })), null);
});
