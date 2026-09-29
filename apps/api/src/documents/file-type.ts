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

/**
 * Policy sources: PDF by signature; DOCX as a ZIP container with a .docx name;
 * Markdown/text by extension, but only if the content is valid UTF-8 text.
 */
export function detectPolicyFileType(
  data: Buffer,
  fileName: string,
): { mimeType: string; extension: string } | null {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  const pdf = detectFileType(data);
  if (pdf?.mimeType === 'application/pdf') return pdf;

  const zip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if (zip && extension === '.docx') {
    return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension };
  }

  if ((extension === '.md' || extension === '.txt') && isUtf8Text(data)) {
    return { mimeType: extension === '.md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8', extension };
  }
  return null;
}

function isUtf8Text(data: Buffer): boolean {
  if (data.length === 0 || data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}
