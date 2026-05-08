const PBKDF2_PREFIX = 'pbkdf2';
const PBKDF2_ITERATIONS = 120000;

function toBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isSubtleCryptoAvailable() {
  return typeof globalThis !== 'undefined' && !!globalThis.crypto?.subtle;
}

async function deriveBits(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password || '')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function isPasswordHash(value) {
  return String(value || '').startsWith(`${PBKDF2_PREFIX}$`);
}

export async function hashPasswordValue(password) {
  const raw = String(password || '');
  if (!raw) return '';
  if (!isSubtleCryptoAvailable()) {
    throw new Error('Password hashing is not available in this environment.');
  }
  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const digestBytes = await deriveBits(raw, saltBytes, PBKDF2_ITERATIONS);
  return [
    PBKDF2_PREFIX,
    String(PBKDF2_ITERATIONS),
    toBase64(saltBytes),
    toBase64(digestBytes),
  ].join('$');
}

export async function verifyPasswordValue(password, storedHash) {
  const rawHash = String(storedHash || '');
  if (!rawHash) return false;
  if (!isPasswordHash(rawHash)) {
    return String(password || '') === rawHash;
  }
  if (!isSubtleCryptoAvailable()) {
    return false;
  }
  const [, iterationsText, saltText, digestText] = rawHash.split('$');
  const iterations = Number(iterationsText) || PBKDF2_ITERATIONS;
  const saltBytes = fromBase64(saltText);
  const expectedDigest = fromBase64(digestText);
  const actualDigest = await deriveBits(String(password || ''), saltBytes, iterations);
  if (actualDigest.length !== expectedDigest.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actualDigest.length; index += 1) {
    mismatch |= actualDigest[index] ^ expectedDigest[index];
  }
  return mismatch === 0;
}
