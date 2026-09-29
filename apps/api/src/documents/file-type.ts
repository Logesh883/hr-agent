/**
 * Identifies an upload by its leading bytes rather than trusting the file
 * name or the browser-declared MIME type.
 */
const signatures: { mimeType: string; extension: string; bytes: number[] }[] = [
  { mimeType: 'application/pdf', extension: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mimeType: 'image/png', extension: '.png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', extension: '.jpg', bytes: [0xff, 0xd8, 0xff] },
];

export function detectFileType(data: Buffer): { mimeType: string; extension: string } | null {
  const match = signatures.find(
    (s) => data.length >= s.bytes.length && s.bytes.every((b, i) => data[i] === b),
  );
  return match ? { mimeType: match.mimeType, extension: match.extension } : null;
}

/** File name safe to store and echo back: no path, no control characters. */
export function sanitizeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return clean || fallback;
}
