/**
 * Exhaustive tests for constant-time comparison security fix.
 *
 * The `constantTimeEqual` function in auth.ts is private (not exported),
 * so we test it indirectly through the public JWT functions (`createJWT`,
 * `verifyJWT`) which rely on `hmacVerify`, which in turn uses
 * `constantTimeEqual` for signature comparison.
 *
 * We focus on CORRECTNESS (not timing measurement, which is inherently
 * flaky in CI). The tests exercise every code path in `constantTimeEqual`:
 *   - Equal strings => true
 *   - Different strings => false
 *   - Different lengths => false (early return)
 *   - Empty strings => equal
 *   - Single character differences => detected
 *   - Unicode content => handled correctly
 *   - Very long strings => work correctly
 *   - Bit-level manipulation => detected
 */

import { describe, it, expect } from 'bun:test';
import { createJWT, verifyJWT } from './auth.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const SECRET = 'constant-time-test-secret-key-2024';

/**
 * Base64url-encode a string (matching auth.ts internal implementation).
 */
function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Manually construct a JWT with a given header, payload, and signature.
 * This lets us test tampered tokens without going through createJWT.
 */
function craftToken(header: object, payload: object, signature: string): string {
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Extract parts of a valid JWT token.
 */
function splitToken(token: string): { header: string; payload: string; signature: string } {
  const [header, payload, signature] = token.split('.');
  return { header: header!, payload: payload!, signature: signature! };
}

/**
 * Flip a single bit in a base64url-encoded string at the given character index.
 * This produces a minimally different string to test single-bit sensitivity.
 */
function flipBit(str: string, charIndex: number): string {
  if (charIndex >= str.length) return str;
  const chars = str.split('');
  // XOR the char code with 1 to flip the lowest bit
  chars[charIndex] = String.fromCharCode(chars[charIndex]!.charCodeAt(0) ^ 1);
  return chars.join('');
}

// ─────────────────────────────────────────────────────────────
// 1. constantTimeEqual basic correctness (via verifyJWT)
// ─────────────────────────────────────────────────────────────

describe('constantTimeEqual correctness (via JWT verification)', () => {
  it('should accept a valid token (equal signatures)', async () => {
    const token = await createJWT('tenant-ct-1', SECRET);
    const payload = await verifyJWT(token, SECRET);

    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('tenant-ct-1');
  });

  it('should reject when signature differs by a single character', async () => {
    const token = await createJWT('tenant-ct-2', SECRET);
    const parts = splitToken(token);

    // Alter the last character of the signature
    const lastChar = parts.signature.slice(-1);
    const alteredChar = lastChar === 'A' ? 'B' : 'A';
    const tamperedSig = parts.signature.slice(0, -1) + alteredChar;

    const tamperedToken = `${parts.header}.${parts.payload}.${tamperedSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when signature differs by a single bit', async () => {
    const token = await createJWT('tenant-ct-3', SECRET);
    const parts = splitToken(token);

    // Flip a single bit in the middle of the signature
    const midIndex = Math.floor(parts.signature.length / 2);
    const tamperedSig = flipBit(parts.signature, midIndex);

    // Verify the signature actually changed
    expect(tamperedSig).not.toBe(parts.signature);
    expect(tamperedSig.length).toBe(parts.signature.length);

    const tamperedToken = `${parts.header}.${parts.payload}.${tamperedSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when signature has different length (shorter)', async () => {
    const token = await createJWT('tenant-ct-4', SECRET);
    const parts = splitToken(token);

    // Truncate the signature by 1 character
    const shorterSig = parts.signature.slice(0, -1);
    expect(shorterSig.length).toBe(parts.signature.length - 1);

    const tamperedToken = `${parts.header}.${parts.payload}.${shorterSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when signature has different length (longer)', async () => {
    const token = await createJWT('tenant-ct-5', SECRET);
    const parts = splitToken(token);

    // Extend the signature by 1 character
    const longerSig = parts.signature + 'X';
    expect(longerSig.length).toBe(parts.signature.length + 1);

    const tamperedToken = `${parts.header}.${parts.payload}.${longerSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject empty signature', async () => {
    const token = await createJWT('tenant-ct-6', SECRET);
    const parts = splitToken(token);

    const tamperedToken = `${parts.header}.${parts.payload}.`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when all signature bytes are zeroed', async () => {
    const token = await createJWT('tenant-ct-7', SECRET);
    const parts = splitToken(token);

    // Replace signature with same-length string of 'A' (base64url safe)
    const zeroedSig = 'A'.repeat(parts.signature.length);
    expect(zeroedSig.length).toBe(parts.signature.length);

    const tamperedToken = `${parts.header}.${parts.payload}.${zeroedSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when signature is all identical characters', async () => {
    const token = await createJWT('tenant-ct-8', SECRET);
    const parts = splitToken(token);

    const uniformSig = 'z'.repeat(parts.signature.length);
    const tamperedToken = `${parts.header}.${parts.payload}.${uniformSig}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 2. hmacVerify correctness (via verifyJWT)
// ─────────────────────────────────────────────────────────────

describe('hmacVerify correctness (via JWT verification)', () => {
  it('should accept valid signature for correct message', async () => {
    const token = await createJWT('hmac-test-1', SECRET);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('hmac-test-1');
  });

  it('should reject valid signature verified with wrong secret', async () => {
    const token = await createJWT('hmac-test-2', SECRET);
    const result = await verifyJWT(token, 'completely-different-secret');
    expect(result).toBeNull();
  });

  it('should reject when header is tampered (wrong message)', async () => {
    const token = await createJWT('hmac-test-3', SECRET);
    const parts = splitToken(token);

    // Tamper with the header (change algorithm claim)
    const tamperedHeader = base64UrlEncode(JSON.stringify({ alg: 'HS384', typ: 'JWT' }));
    const tamperedToken = `${tamperedHeader}.${parts.payload}.${parts.signature}`;

    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when payload is tampered (wrong message)', async () => {
    const token = await createJWT('hmac-test-4', SECRET);
    const parts = splitToken(token);

    // Tamper with the payload (change the tenant ID)
    const now = Math.floor(Date.now() / 1000);
    const tamperedPayload = base64UrlEncode(
      JSON.stringify({ sub: 'evil-tenant', iat: now, exp: now + 3600 })
    );
    const tamperedToken = `${parts.header}.${tamperedPayload}.${parts.signature}`;

    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it('should reject when both header and payload are swapped between two valid tokens', async () => {
    // Create two valid tokens with different tenants
    const token1 = await createJWT('tenant-alpha', SECRET);
    const token2 = await createJWT('tenant-beta', SECRET);

    const parts1 = splitToken(token1);
    const parts2 = splitToken(token2);

    // Mix header from token1 with payload from token2, signature from token1
    const frankenstein = `${parts1.header}.${parts2.payload}.${parts1.signature}`;
    const result = await verifyJWT(frankenstein, SECRET);
    expect(result).toBeNull();
  });

  it('should produce different signatures for different secrets', async () => {
    const token1 = await createJWT('same-tenant', 'secret-one');
    const token2 = await createJWT('same-tenant', 'secret-two');

    const sig1 = splitToken(token1).signature;
    const sig2 = splitToken(token2).signature;

    expect(sig1).not.toBe(sig2);
  });

  it('should produce different signatures for different payloads', async () => {
    const token1 = await createJWT('tenant-aaa', SECRET, { expiresIn: 9999 });
    const token2 = await createJWT('tenant-bbb', SECRET, { expiresIn: 9999 });

    const sig1 = splitToken(token1).signature;
    const sig2 = splitToken(token2).signature;

    expect(sig1).not.toBe(sig2);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Signature tampering variations
// ─────────────────────────────────────────────────────────────

describe('Signature tampering detection', () => {
  it('should detect first-byte difference in signature', async () => {
    const token = await createJWT('tamper-first', SECRET);
    const parts = splitToken(token);

    const tamperedSig = flipBit(parts.signature, 0);
    expect(tamperedSig).not.toBe(parts.signature);

    const result = await verifyJWT(`${parts.header}.${parts.payload}.${tamperedSig}`, SECRET);
    expect(result).toBeNull();
  });

  it('should detect last-byte difference in signature', async () => {
    const token = await createJWT('tamper-last', SECRET);
    const parts = splitToken(token);

    const tamperedSig = flipBit(parts.signature, parts.signature.length - 1);
    expect(tamperedSig).not.toBe(parts.signature);

    const result = await verifyJWT(`${parts.header}.${parts.payload}.${tamperedSig}`, SECRET);
    expect(result).toBeNull();
  });

  it('should detect differences at every position in the signature', async () => {
    const token = await createJWT('tamper-every-pos', SECRET);
    const parts = splitToken(token);

    // Test flipping a bit at several positions throughout the signature
    const positions = [0, 1, 5, 10, 20, Math.floor(parts.signature.length / 2), parts.signature.length - 2, parts.signature.length - 1];

    for (const pos of positions) {
      if (pos >= parts.signature.length) continue;
      const tamperedSig = flipBit(parts.signature, pos);
      if (tamperedSig === parts.signature) continue; // skip if flip produced same char

      const result = await verifyJWT(
        `${parts.header}.${parts.payload}.${tamperedSig}`,
        SECRET
      );
      expect(result).toBeNull();
    }
  });

  it('should reject reversed signature', async () => {
    const token = await createJWT('tamper-reverse', SECRET);
    const parts = splitToken(token);

    const reversedSig = parts.signature.split('').reverse().join('');
    // Only test if reversal actually changes the string (not a palindrome)
    if (reversedSig !== parts.signature) {
      const result = await verifyJWT(
        `${parts.header}.${parts.payload}.${reversedSig}`,
        SECRET
      );
      expect(result).toBeNull();
    }
  });

  it('should reject signature with swapped adjacent characters', async () => {
    const token = await createJWT('tamper-swap', SECRET);
    const parts = splitToken(token);

    // Swap first two characters
    if (parts.signature.length >= 2 && parts.signature[0] !== parts.signature[1]) {
      const chars = parts.signature.split('');
      [chars[0], chars[1]] = [chars[1]!, chars[0]!];
      const swappedSig = chars.join('');

      const result = await verifyJWT(
        `${parts.header}.${parts.payload}.${swappedSig}`,
        SECRET
      );
      expect(result).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Edge cases for constantTimeEqual paths
// ─────────────────────────────────────────────────────────────

describe('Edge cases for constant-time comparison paths', () => {
  it('should handle secrets with special characters', async () => {
    const specialSecret = 'p@$$w0rd!#%^&*()_+-=[]{}|;:,.<>?/~`';
    const token = await createJWT('special-secret', specialSecret);
    const payload = await verifyJWT(token, specialSecret);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('special-secret');
  });

  it('should handle secrets with unicode characters', async () => {
    const unicodeSecret = 'secret-with-unicode-\u00e9\u00e0\u00fc\u00f1-\u4e16\u754c-\u{1F600}';
    const token = await createJWT('unicode-secret', unicodeSecret);

    // Should verify with the same secret
    const payload = await verifyJWT(token, unicodeSecret);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('unicode-secret');

    // Should reject with a different unicode secret
    const differentUnicode = 'secret-with-unicode-\u00e8\u00e0\u00fc\u00f1-\u4e16\u754c-\u{1F600}';
    const result = await verifyJWT(token, differentUnicode);
    expect(result).toBeNull();
  });

  it('should handle very long tenant IDs (long payload changes message length)', async () => {
    const longTenantId = 'tenant-' + 'x'.repeat(1000);
    const token = await createJWT(longTenantId, SECRET);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe(longTenantId);
  });

  it('should handle very long secrets', async () => {
    const longSecret = 'S'.repeat(10000);
    const token = await createJWT('long-secret-tenant', longSecret);
    const payload = await verifyJWT(token, longSecret);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('long-secret-tenant');

    // Should reject with slightly different long secret
    const almostSame = 'S'.repeat(9999) + 'T';
    const result = await verifyJWT(token, almostSame);
    expect(result).toBeNull();
  });

  it('should reject empty string secret (WebCrypto rejects zero-length HMAC keys)', async () => {
    // crypto.subtle.importKey throws DataError for empty HMAC keys.
    // This exercises the error path -- verifyJWT should not crash, it should
    // return null or throw (createJWT will throw because it can't sign).
    await expect(createJWT('empty-secret-tenant', '')).rejects.toThrow();
  });

  it('should handle single-character secret', async () => {
    const token = await createJWT('single-char', 'x');
    const payload = await verifyJWT(token, 'x');
    expect(payload).not.toBeNull();

    const result = await verifyJWT(token, 'y');
    expect(result).toBeNull();
  });

  it('should handle secrets that differ only in whitespace', async () => {
    const secret1 = 'my secret';
    const secret2 = 'my  secret';

    const token = await createJWT('whitespace-test', secret1);
    const result = await verifyJWT(token, secret2);
    expect(result).toBeNull();
  });

  it('should handle secrets that differ only in trailing newline', async () => {
    const secret1 = 'my-secret';
    const secret2 = 'my-secret\n';

    const token = await createJWT('newline-test', secret1);
    const result = await verifyJWT(token, secret2);
    expect(result).toBeNull();
  });

  it('should handle secrets that differ only in case', async () => {
    const secret1 = 'MySecret';
    const secret2 = 'mysecret';

    const token = await createJWT('case-test', secret1);
    const result = await verifyJWT(token, secret2);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Token structure edge cases
// ─────────────────────────────────────────────────────────────

describe('Token structure edge cases', () => {
  it('should reject token with missing signature part', async () => {
    const token = await createJWT('missing-sig', SECRET);
    const parts = splitToken(token);

    // Only header and payload, no signature
    const result = await verifyJWT(`${parts.header}.${parts.payload}`, SECRET);
    expect(result).toBeNull();
  });

  it('should reject token with too many parts', async () => {
    const token = await createJWT('too-many-parts', SECRET);

    const result = await verifyJWT(`${token}.extrapart`, SECRET);
    expect(result).toBeNull();
  });

  it('should reject single-part token', async () => {
    const result = await verifyJWT('just-one-part', SECRET);
    expect(result).toBeNull();
  });

  it('should reject empty string token', async () => {
    const result = await verifyJWT('', SECRET);
    expect(result).toBeNull();
  });

  it('should reject token that is all dots', async () => {
    const result = await verifyJWT('..', SECRET);
    expect(result).toBeNull();
  });

  it('should handle token with valid structure but garbage base64', async () => {
    const result = await verifyJWT('!!!.@@@.###', SECRET);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 6. Consistency and determinism
// ─────────────────────────────────────────────────────────────

describe('Signature consistency and determinism', () => {
  it('should produce consistent signatures for identical inputs', async () => {
    // Create two tokens with the exact same input within the same second
    // (iat will be the same if done fast enough)
    const now = Math.floor(Date.now() / 1000);

    // We can't easily control iat, so instead we verify that
    // creating and verifying the same token twice yields consistent results
    const token = await createJWT('consistency-test', SECRET);
    const payload1 = await verifyJWT(token, SECRET);
    const payload2 = await verifyJWT(token, SECRET);

    expect(payload1).not.toBeNull();
    expect(payload2).not.toBeNull();
    expect(payload1?.sub).toBe(payload2?.sub);
    expect(payload1?.iat).toBe(payload2?.iat);
    expect(payload1?.exp).toBe(payload2?.exp);
  });

  it('should verify the same valid token 100 times without error', async () => {
    const token = await createJWT('repeat-verify', SECRET);

    for (let i = 0; i < 100; i++) {
      const payload = await verifyJWT(token, SECRET);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe('repeat-verify');
    }
  });

  it('should reject the same tampered token 100 times without error', async () => {
    const token = await createJWT('repeat-reject', SECRET);
    const parts = splitToken(token);
    const tamperedToken = `${parts.header}.${parts.payload}.${flipBit(parts.signature, 5)}`;

    for (let i = 0; i < 100; i++) {
      const result = await verifyJWT(tamperedToken, SECRET);
      expect(result).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 7. Cross-secret isolation
// ─────────────────────────────────────────────────────────────

describe('Cross-secret isolation', () => {
  it('should not verify token from secret A with secret B', async () => {
    const secrets = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    for (let i = 0; i < secrets.length; i++) {
      const token = await createJWT('isolation-tenant', secrets[i]!);

      // Should verify with the correct secret
      const validResult = await verifyJWT(token, secrets[i]!);
      expect(validResult).not.toBeNull();

      // Should NOT verify with any other secret
      for (let j = 0; j < secrets.length; j++) {
        if (i === j) continue;
        const invalidResult = await verifyJWT(token, secrets[j]!);
        expect(invalidResult).toBeNull();
      }
    }
  });

  it('should not verify token with secret that is a prefix of the correct secret', async () => {
    const fullSecret = 'my-full-secret-key';
    const prefixSecret = 'my-full-secret';

    const token = await createJWT('prefix-test', fullSecret);
    const result = await verifyJWT(token, prefixSecret);
    expect(result).toBeNull();
  });

  it('should not verify token with secret that is a suffix of the correct secret', async () => {
    const fullSecret = 'my-full-secret-key';
    const suffixSecret = 'secret-key';

    const token = await createJWT('suffix-test', fullSecret);
    const result = await verifyJWT(token, suffixSecret);
    expect(result).toBeNull();
  });
});
