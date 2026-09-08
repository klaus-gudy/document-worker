import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** CSS lengths, e.g. "18mm", "0.5in", "24px". */
const CSS_LENGTH = /^\d+(\.\d+)?(mm|cm|in|px|pt)$/;

export class PdfMarginDto {
  @ApiPropertyOptional({ example: '18mm' })
  @IsOptional()
  @Matches(CSS_LENGTH, { message: 'top must be a CSS length like "18mm"' })
  top?: string;

  @ApiPropertyOptional({ example: '20mm' })
  @IsOptional()
  @Matches(CSS_LENGTH, { message: 'bottom must be a CSS length like "20mm"' })
  bottom?: string;

  @ApiPropertyOptional({ example: '16mm' })
  @IsOptional()
  @Matches(CSS_LENGTH, { message: 'left must be a CSS length like "16mm"' })
  left?: string;

  @ApiPropertyOptional({ example: '16mm' })
  @IsOptional()
  @Matches(CSS_LENGTH, { message: 'right must be a CSS length like "16mm"' })
  right?: string;
}

/** Page formats Playwright accepts. */
const PAGE_FORMATS = [
  'Letter',
  'Legal',
  'Tabloid',
  'Ledger',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
] as const;

export class RenderPdfDto {
  @ApiProperty({
    description:
      'A complete HTML document, stylesheet inlined. Rendered exactly as ' +
      'given — nothing is added to it.',
    example:
      '<!doctype html><html><body><h1>Hello</h1><p>From Chromium.</p></body></html>',
  })
  @IsString()
  @IsNotEmpty()
  // A ceiling so a single request cannot hand Chromium an unbounded document.
  // 5MB of markup is already an enormous page; this is a guard, not a target.
  @MaxLength(5_000_000, {
    message: 'html must be at most 5,000,000 characters',
  })
  html: string;

  @ApiPropertyOptional({
    description:
      'Name offered in the Content-Disposition header. ".pdf" is appended ' +
      'when missing.',
    example: 'report.pdf',
    default: 'document.pdf',
  })
  @IsOptional()
  @IsString()
  // No path separators, no quotes, no control characters: this value is
  // interpolated into a Content-Disposition header, where a stray `"` or
  // newline would let a caller forge header content.
  @Matches(/^[A-Za-z0-9._-]{1,120}$/, {
    message:
      'fileName may only contain letters, digits, dot, underscore and hyphen',
  })
  fileName?: string;

  @ApiPropertyOptional({
    description: 'Printed at the foot of every page, beside a page counter.',
    example: 'Tenancy agreement · L-7F3QA',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  footerText?: string;

  @ApiPropertyOptional({ enum: PAGE_FORMATS, default: 'A4' })
  @IsOptional()
  @IsIn(PAGE_FORMATS)
  format?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  landscape?: boolean;

  @ApiPropertyOptional({ type: PdfMarginDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PdfMarginDto)
  margin?: PdfMarginDto;

  @ApiPropertyOptional({
    description:
      'Allow the page to fetch over the network. Off by default: this renders ' +
      'caller-supplied HTML inside a browser on the service network, so an ' +
      'external reference is a request to somewhere the caller may not reach ' +
      'directly. Inline content (including data: URIs) always works.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowRemoteContent?: boolean;
}
