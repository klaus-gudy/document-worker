import { Module } from '@nestjs/common';

import { PdfController } from '@/modules/pdf/pdf.controller';
import { PdfService } from '@/modules/pdf/pdf.service';

/**
 * `PdfService` is exported because it is the reusable half — whatever ends up
 * handling `lease.created` will render through the same browser rather than
 * launching a second one.
 */
@Module({
  controllers: [PdfController],
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
