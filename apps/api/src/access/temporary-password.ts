import { randomInt } from 'node:crypto';

// No look-alikes (0/O, 1/l/I), so it can be read out or typed from a note.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * One-time password handed to a new user, e.g. "hq7K-3mPz-Wn8c".
 * 12 random characters from 55 ≈ 69 bits of entropy.
 */
export function generateTemporaryPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
    const password = [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
    // Always include a letter and a digit.
    if (/[A-Za-z]/.test(password) && /\d/.test(password)) return password;
  }
}
