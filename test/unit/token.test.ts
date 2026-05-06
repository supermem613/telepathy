import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { encodeToken, decodeToken, generateSecret, pickLocalIPv4 } from "../../src/core/token.js";

describe("token round-trip", () => {
  it("encodes and decodes the same payload", () => {
    const secret = generateSecret();
    const token = encodeToken({ host: "192.168.1.42", port: 7423, secret });
    const decoded = decodeToken(token);
    assert.equal(decoded.host, "192.168.1.42");
    assert.equal(decoded.port, 7423);
    assert.deepEqual(decoded.secret, secret);
  });

  it("emits the expected TLP1 prefix + dashless dotless base32 body (one word, easy to double-click)", () => {
    const token = encodeToken({ host: "10.0.0.1", port: 1, secret: Buffer.alloc(8) });
    assert.match(token, /^TLP1[A-Z2-7]+$/);
    assert.equal(token.includes("-"), false, "token must not contain dashes");
    assert.equal(token.includes("."), false, "token must not contain dots");
    assert.equal(token.includes(" "), false, "token must not contain spaces");
  });

  it("tolerates whitespace, lowercase, dashes, and underscores on decode (legacy hand-typed tokens)", () => {
    const secret = generateSecret();
    const token = encodeToken({ host: "192.168.1.42", port: 7423, secret });
    // Simulate someone manually adding whitespace, dashes, lowercase
    const body = token.slice(4);  // strip "TLP1"
    const sloppy = `  tlp1-${body.toLowerCase().slice(0, 5)}-${body.toLowerCase().slice(5, 10)}-${body.toLowerCase().slice(10)}  `;
    const decoded = decodeToken(sloppy);
    assert.equal(decoded.host, "192.168.1.42");
    assert.equal(decoded.port, 7423);
    assert.deepEqual(decoded.secret, secret);
  });

  it("rejects tokens without the TLP1 prefix", () => {
    assert.throws(() => decodeToken("AAAAABBBBBCCCCCDDDDDEEEEE"), /missing "TLP1" prefix/);
  });

  it("rejects tokens with non-base32 characters", () => {
    assert.throws(() => decodeToken("TLP1AAAAABBBBBCCCCCDDDDDEE9!"), /unexpected character/);
  });

  it("rejects tokens that decode to the wrong byte length", () => {
    assert.throws(() => decodeToken("TLP1AA"), /expected 14/);
  });

  it("encodes ports correctly across the full range", () => {
    for (const port of [1, 80, 443, 7423, 65535]) {
      const decoded = decodeToken(encodeToken({ host: "1.2.3.4", port, secret: Buffer.alloc(8, 0xab) }));
      assert.equal(decoded.port, port);
    }
  });

  it("rejects non-IPv4 hosts at encode time", () => {
    assert.throws(() => encodeToken({ host: "box-a", port: 7423, secret: Buffer.alloc(8) }), /not an IPv4/);
  });
});

describe("token.pickLocalIPv4", () => {
  it("returns a non-empty string", () => {
    const ip = pickLocalIPv4();
    assert.equal(typeof ip, "string");
    assert.ok(ip.length > 0);
  });

  it("returns either a real IPv4 or the loopback fallback", () => {
    const ip = pickLocalIPv4();
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

describe("token.generateSecret", () => {
  it("returns 8 bytes", () => {
    assert.equal(generateSecret().length, 8);
  });

  it("differs across calls", () => {
    assert.notDeepEqual(generateSecret(), generateSecret());
  });
});
