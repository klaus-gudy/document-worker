/**
 * Which bytes may be stored, mirrored from the app's `lib/document-options.ts`.
 *
 * An **allowlist**, not a blocklist, and matched on the MIME type rather than
 * the file extension. This worker only ever files `application/pdf`, so the
 * table is here for one thing: the extension an object key gets is taken from
 * the verified type, never from a file name.
 */
type FileTypeTable = Record<string, { extension: string; label: string }>;

export const ACCEPTED_FILE_TYPES: FileTypeTable = {
  'application/pdf': { extension: '.pdf', label: 'PDF' },
  'image/jpeg': { extension: '.jpg', label: 'JPEG' },
  'image/png': { extension: '.png', label: 'PNG' },
  'image/webp': { extension: '.webp', label: 'WebP' },
};

export const PDF_MIME_TYPE = 'application/pdf';
