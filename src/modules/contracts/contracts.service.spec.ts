import { Logger } from '@nestjs/common';

import {
  CONTRACT_PDF_OPTIONS,
  FOOTER_TEXT_MAX,
} from '@/modules/contracts/contracts.constants';
import { ContractsService } from '@/modules/contracts/contracts.service';
import type { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';
import type { PdfService } from '@/modules/pdf/pdf.service';
import type { StorageService } from '@/storage/storage.service';

/**
 * The service is testable with no browser and no bucket, which is the reason it
 * is separate from the listener at all — so these tests construct it directly
 * with doubles rather than standing up a Nest container.
 */
describe('ContractsService', () => {
  let service: ContractsService;
  let render: jest.Mock<Promise<Buffer>, [string, unknown]>;
  let putObject: jest.Mock<Promise<void>, [string, Uint8Array, string]>;
  let logged: string[];

  const event: LeaseCreatedEvent = {
    html: '<html><body><h1>Lease Agreement</h1></body></html>',
    objectKey: 'organizations/org-123/leases/lease-456/contracts/asset-789.pdf',
  };

  const pdfBytes = Buffer.from('%PDF-1.4 pretend');

  beforeEach(() => {
    logged = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => logged.push(String(message)));

    render = jest
      .fn<Promise<Buffer>, [string, unknown]>()
      .mockResolvedValue(pdfBytes);
    putObject = jest
      .fn<Promise<void>, [string, Uint8Array, string]>()
      .mockResolvedValue(undefined);

    service = new ContractsService(
      { render } as unknown as PdfService,
      { putObject } as unknown as StorageService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders the HTML it was sent', async () => {
    await service.handleLeaseCreated(event);

    expect(render).toHaveBeenCalledWith(event.html, expect.anything());
  });

  it('always lays the page out the same way, whatever the message says', async () => {
    // The point of pinning these: a stored contract is a record, and one laid
    // out however the publisher felt that day cannot be reproduced. A message
    // carrying layout is ignored rather than honoured.
    await service.handleLeaseCreated({
      ...event,
      format: 'A5',
      landscape: true,
      margin: { top: '0mm' },
      allowRemoteContent: true,
    } as LeaseCreatedEvent);

    expect(render).toHaveBeenCalledWith(event.html, CONTRACT_PDF_OPTIONS);
    expect(CONTRACT_PDF_OPTIONS).toEqual({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '18mm',
        right: '16mm',
        bottom: '20mm',
        left: '16mm',
      },
    });
  });

  it('prints the footer text the message supplied, alongside the fixed layout', async () => {
    // The one exception to the rule above, and it is about *content*: the
    // template name and contract reference are things only the publisher
    // knows. Everything around them is still this service's to decide.
    await service.handleLeaseCreated({
      ...event,
      footerText: 'Standard tenancy agreement · L-LWX8G',
    });

    expect(render).toHaveBeenCalledWith(event.html, {
      ...CONTRACT_PDF_OPTIONS,
      footerText: 'Standard tenancy agreement · L-LWX8G',
    });
  });

  it('renders no footer when the message does not ask for one', async () => {
    // Not `footerText: ''` — an empty template still sets displayHeaderFooter,
    // which draws the page counter with nothing beside it.
    await service.handleLeaseCreated({ ...event, footerText: '   ' });

    const options = render.mock.calls[0]?.[1] as { footerText?: string };
    expect(options.footerText).toBeUndefined();
    expect(options).toEqual(CONTRACT_PDF_OPTIONS);
  });

  it('truncates a runaway footer rather than refusing to file the contract', async () => {
    // A queue message never passes through `ValidationPipe`, so the cap the
    // HTTP route gets from `RenderPdfDto` has to be applied here too.
    await service.handleLeaseCreated({ ...event, footerText: 'x'.repeat(500) });

    const options = render.mock.calls[0]?.[1] as { footerText?: string };
    expect(options.footerText).toHaveLength(FOOTER_TEXT_MAX);
  });

  it('stores the rendered bytes under the key the message chose', async () => {
    await service.handleLeaseCreated(event);

    expect(putObject).toHaveBeenCalledWith(
      event.objectKey,
      pdfBytes,
      'application/pdf',
    );
  });

  it('uploads only after rendering succeeds', async () => {
    render.mockRejectedValue(new Error('Chromium died'));

    await expect(service.handleLeaseCreated(event)).rejects.toThrow(
      'Chromium died',
    );
    // An object written from a failed render would be a corrupt contract that
    // nothing reports as broken.
    expect(putObject).not.toHaveBeenCalled();
  });

  it('lets a storage failure propagate, so the listener can decide what to do', async () => {
    putObject.mockRejectedValue(new Error('bucket unreachable'));

    await expect(service.handleLeaseCreated(event)).rejects.toThrow(
      'bucket unreachable',
    );
  });

  it('reports where it put the document and how big it was', async () => {
    await service.handleLeaseCreated(event);

    expect(logged[0]).toContain(event.objectKey);
    expect(logged[0]).toContain(`${pdfBytes.byteLength} bytes`);
  });

  it('hands the publisher meta back untouched', async () => {
    // The point of the field: this service carries the publisher's ids without
    // ever learning what they mean. Nested and oddly-shaped on purpose — an
    // echo that reshapes anything is not an echo.
    const meta = {
      organizationId: 'org-123',
      leaseId: 'lease-456',
      missing: ['tenant_nidaNumber'],
      nested: { deep: [1, { two: true }] },
    };

    const result = await service.handleLeaseCreated({ ...event, meta });

    expect(result.meta).toEqual(meta);
  });

  it('omits meta entirely when the request carried none', async () => {
    // Not `meta: {}` — a publisher checking whether it got its own data back
    // should be able to tell "nothing was sent" from "an empty object was".
    const result = await service.handleLeaseCreated(event);

    expect('meta' in result).toBe(false);
  });

  it('never lets meta influence the render or the upload', async () => {
    // It is opaque. A publisher cannot smuggle layout or a destination through
    // it, which is the whole reason it can be accepted unvalidated.
    await service.handleLeaseCreated({
      ...event,
      meta: { objectKey: 'somewhere/else.pdf', format: 'A5', footerText: 'no' },
    });

    expect(render).toHaveBeenCalledWith(event.html, CONTRACT_PDF_OPTIONS);
    expect(putObject).toHaveBeenCalledWith(
      event.objectKey,
      pdfBytes,
      'application/pdf',
    );
  });

  it('returns everything a caller needs to announce completion elsewhere', async () => {
    // This is what `LeaseCreatedListener` publishes on `document.stored`. It
    // has to come from here rather than the listener reconstructing it,
    // because the listener never touches the rendered bytes and has no other
    // way to know their size or when the upload actually finished.
    const result = await service.handleLeaseCreated(event);

    expect(result.objectKey).toBe(event.objectKey);
    expect(result.contentType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(pdfBytes.byteLength);
    expect(new Date(result.storedAt).toISOString()).toBe(result.storedAt);
  });
});
