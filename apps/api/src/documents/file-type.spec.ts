import { detectFileType, sanitizeFileName } from './file-type.js';

describe('detectFileType', () => {
  it('recognises PDF, PNG and JPEG by their leading bytes', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7\n...'))?.mimeType).toBe('application/pdf');
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.mimeType).toBe('image/png');
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.extension).toBe('.jpg');
  });

  it('rejects anything else, whatever it is named', () => {
    expect(detectFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileType(Buffer.from('MZ\x90\x00'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it('strips paths, quotes and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd', 'x')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\PAN "card".pdf', 'x')).toBe('PAN card.pdf');
    expect(sanitizeFileName('bad\u0000name\n.pdf', 'x')).toBe('badname.pdf');
  });

  it('falls back when nothing usable is left', () => {
    expect(sanitizeFileName('   ', 'PAN card.pdf')).toBe('PAN card.pdf');
  });
});
