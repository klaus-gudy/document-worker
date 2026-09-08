import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RenderPdfDto } from '@/modules/pdf/dto/render-pdf.dto';
import { PdfService } from '@/modules/pdf/pdf.service';

/**
 * HTML in, PDF out.
 *
 * A real HTTP endpoint rather than a scratch "playground": rendering HTML to a
 * stored PDF is what this service exists to do, and the same `PdfService` is
 * what a `lease.created` handler will call once that path is built. Having it
 * reachable over HTTP is what makes the rendering testable on its own — paste
 * a document in, look at what comes out — without publishing a queue message
 * to find out.
 */
@ApiTags('pdf')
@Controller('pdf')
export class PdfController {
  constructor(private readonly pdf: PdfService) {}

  @Post('render')
  // 200, not the 201 Nest gives POST by default: this creates nothing that can
  // be fetched again, it returns a representation of what was sent.
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Render HTML to PDF',
    description:
      'Takes a complete HTML document and streams back the rendered PDF. ' +
      'Rendered by headless Chromium, so the output matches what a browser ' +
      'would print rather than a re-implementation of CSS.',
  })
  @ApiBody({ type: RenderPdfDto })
  @ApiProduces('application/pdf')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The rendered PDF.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'The body failed validation.',
  })
  async render(@Body() body: RenderPdfDto): Promise<StreamableFile> {
    const { html, fileName, ...options } = body;

    const pdf = await this.pdf.render(html, options);

    const name = fileName ?? 'document.pdf';
    const withExtension = name.toLowerCase().endsWith('.pdf')
      ? name
      : `${name}.pdf`;

    /*
     * `StreamableFile` rather than returning the buffer directly: Nest pipes it
     * to the response and sets Content-Length from it, so a large document does
     * not have to be serialised through the JSON interceptor first.
     *
     * `inline` rather than `attachment` — the common case for a rendered
     * contract is looking at it in the browser's own PDF viewer. The filename
     * is still carried, so "save as" offers the right name. The DTO restricts
     * it to a safe character set, which is what keeps this interpolation from
     * being a header-injection.
     */
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${withExtension}"`,
    });
  }
}
