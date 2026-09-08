import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { chromium, type Browser } from 'playwright';

import type { RenderOptions } from '../events/events.types';

/**
 * HTML to PDF, through a real browser engine.
 *
 * Chosen over a pure-JS generator (pdfmake and friends) for one reason: the
 * document's look was already decided by whoever sent the HTML, and approved in
 * whatever preview they approved it in. A layout engine that re-implements CSS
 * produces something *similar*, which means the stored PDF and the preview
 * drift apart and nobody can say which one is right. Chromium renders the same
 * stylesheet a browser does, so the PDF is the preview.
 *
 * The cost is honest and worth stating: this pulls a ~100MB browser download,
 * and the process needs it present. **That is the reason this worker exists as
 * a separate service** — the Next.js app never has to have a browser installed.
 *
 *   npx playwright install --with-deps chromium
 */
/**
 * Jarvis's contract margins. Applied to anything that does not ask for its own,
 * so the common case — a document laid out for A4 with room for the footer —
 * needs no options at all.
 */
const DEFAULT_MARGIN = {
  top: '18mm',
  bottom: '20mm',
  left: '16mm',
  right: '16mm',
} as const;

@Injectable()
export class PdfService implements OnApplicationShutdown {
  private readonly logger = new Logger(PdfService.name);

  /**
   * One browser per process, launched on first use.
   *
   * Launching Chromium takes on the order of a second, which is fine once and
   * absurd per contract. Not launched in `onModuleInit`, deliberately: a worker
   * that comes up to an empty queue and sits there for a day should not be
   * holding a browser open the whole time.
   */
  private browser?: Promise<Browser>;

  private getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;

    const started = chromium.launch();
    this.browser = started;

    const invalidate = () => {
      // A crashed browser is not reusable; drop it so the next render launches
      // a fresh one rather than throwing "Target closed" forever after.
      if (this.browser === started) this.browser = undefined;
    };

    started.then(
      (browser) => browser.on('disconnected', invalidate),
      invalidate,
    );

    return started;
  }

  /**
   * Renders a complete HTML document to PDF bytes.
   *
   * `setContent` rather than navigating to a `data:` or `file:` URL — the
   * document arrives as a string, has no origin, and needs none. That is also
   * the containment: with no origin there is nothing for a `fetch` in the
   * markup to be same-origin with, and `waitUntil: "load"` will not wait on one.
   * The caller is expected to have inlined its stylesheet and sanitized its own
   * markup before sending it; this renders what it is given.
   */
  async htmlToPdf(
    html: string,
    { footerText, format, landscape, margin }: RenderOptions = {},
  ): Promise<Uint8Array> {
    const browser = await this.getBrowser();
    // A fresh context per render, closed in `finally`: contexts are cheap, and
    // sharing one across tenants would share its cookies and storage too.
    const context = await browser.newContext();

    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });

      return await page.pdf({
        format: format ?? 'A4',
        landscape: landscape ?? false,
        // The document's own background — highlighted variables in particular —
        // is content, not decoration.
        printBackground: true,
        margin: { ...DEFAULT_MARGIN, ...margin },
        displayHeaderFooter: Boolean(footerText),
        headerTemplate: '<span></span>',
        footerTemplate: footerText
          ? // The page counter is one child, not three: `space-between` spreads
            // every child evenly, which turns "1 / 2" into "1     /     2".
            `<div style="width:100%;padding:0 16mm;font-family:Helvetica,Arial,sans-serif;font-size:8pt;color:#666;display:flex;justify-content:space-between;">
               <span>${escapeForTemplate(footerText)}</span>
               <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
             </div>`
          : '<span></span>',
      });
    } finally {
      await context.close();
    }
  }

  /** Shuts the shared browser down, so the process can actually exit. */
  async onApplicationShutdown() {
    const existing = this.browser;
    if (!existing) return;
    this.browser = undefined;

    try {
      await (await existing).close();
      this.logger.log('Chromium closed');
    } catch {
      // Already gone; nothing to close.
    }
  }
}

/**
 * Chromium's header/footer templates are HTML, and the text put in them here is
 * a template name and a contract reference — both free text from the database.
 */
function escapeForTemplate(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
