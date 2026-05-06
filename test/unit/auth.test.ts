import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { secretToPsk } from "../../src/core/auth.js";
import { generateSecret } from "../../src/core/token.js";

describe("auth.secretToPsk", () => {
  it("returns a 32-byte PSK", () => {
    const psk = secretToPsk(generateSecret());
    assert.equal(psk.length, 32);
  });

  it("is deterministic for the same secret", () => {
    const s = generateSecret();
    assert.deepEqual(secretToPsk(s), secretToPsk(s));
  });

  it("differs for different secrets", () => {
    const a = secretToPsk(generateSecret());
    const b = secretToPsk(generateSecret());
    assert.notDeepEqual(a, b);
  });
});
