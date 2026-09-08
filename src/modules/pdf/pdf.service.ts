import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { chromium, type Browser } from 'playwright';

/** How a document should be laid out on the page. */
export type RenderOptions = {
  /** Printed at the foot of every page, with a page counter beside it. */
  footerText?: string;
  /** Any Playwright page format. Defaults to A4. */
  format?: string;
  landscape?: boolean;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
  /**
   * Whether the page may fetch anything over the network. **Off by default** —
   * see the note on `render`.
   */
  allowRemoteContent?: boolean;
};

/**
 * HTML to PDF, through a real browser engine.
 *
 * Chromium rather than a pure-JS generator (pdfmake and friends) for one
 * reason: whatever produced the HTML has already decided what it looks like,
 * in CSS, and probably approved it in a browser. A layout engine that
 * re-implements CSS produces something *similar*, so the stored PDF and the
 * preview drift apart and nobody can say which is right. Chromium renders the
 * same stylesheet a browser does, so the PDF is the preview.
 *
 * The cost is honest and worth stating: this needs a ~100MB browser present on
 * the host (`npx playwright install chromium`), which is precisely the reason
 * a job like this belongs in its own service rather than inside a web app.
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
   * absurd per request. Not launched at startup, deliberately: a worker that
   * comes up and is never asked to render anything should not be holding a
   * browser open the whole time.
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
   * document arrives as a string, has no origin, and needs none.
   *
   * **Remote content is blocked unless asked for.** This renders HTML supplied
   * by whoever called the endpoint, inside a browser that sits on this
   * service's network. Left open, `<img src="http://169.254.169.254/...">` is a
   * request to somewhere a caller should not be able to reach — a plain SSRF.
   * Everything inline (`data:` URIs included) still works, which is what a
   * self-contained printable document uses anyway; `allowRemoteContent` opts
   * back in when a caller genuinely needs a remote stylesheet or font.
   */
  async render(html: string, options: RenderOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    // A fresh context per render, closed in `finally`: contexts are cheap, and
    // sharing one across callers would share its cookies and storage too.
    const context = await browser.newContext();

    try {
      const page = await context.newPage();

      if (!options.allowRemoteContent) {
        await page.route('**/*', (route) => {
          const url = route.request().url();
          // `setContent` itself is served as about:blank; data: and blob: are
          // inline and never touch the network.
          const isInline =
            url.startsWith('data:') ||
            url.startsWith('blob:') ||
            url.startsWith('about:');
          return isInline ? route.continue() : route.abort();
        });
      }

      await page.setContent(html, { waitUntil: 'load' });

      return await page.pdf({
        format: options.format ?? 'A4',
        landscape: options.landscape ?? false,
        // The document's own background is content, not decoration — without
        // this, every coloured block and highlight prints white.
        printBackground: true,
        margin: { ...DEFAULT_MARGIN, ...options.margin },
        displayHeaderFooter: Boolean(options.footerText),
        headerTemplate: '<span></span>',
        footerTemplate: options.footerText
          ? // The page counter is one child, not three: `space-between` spreads
            // every child evenly, which turns "1 / 2" into "1     /     2".
            `<div style="width:100%;padding:0 16mm;font-family:Helvetica,Arial,sans-serif;font-size:8pt;color:#666;display:flex;justify-content:space-between;">
               <span>${escapeForTemplate(options.footerText)}</span>
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
 * Chromium's footer template is HTML, and the text put in it here comes
 * straight from the request body.
 */
function escapeForTemplate(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
