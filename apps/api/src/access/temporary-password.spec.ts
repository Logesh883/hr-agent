import { generateTemporaryPassword } from './temporary-password.js';

describe('generateTemporaryPassword', () => {
  it('is three groups of four unambiguous characters with a letter and a digit', () => {
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
      expect(password).toMatch(/[A-Za-z]/);
      expect(password).toMatch(/\d/);
      expect(password).not.toMatch(/[01OlI]/);
    }
  });

  it("doesn't repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(1000);
  });
});
