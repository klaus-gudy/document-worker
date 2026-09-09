import { Logger } from '@nestjs/common';

import { CONTRACT_PDF_OPTIONS } from '@/modules/contracts/contracts.constants';
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

  it('always renders with the fixed contract options, never anything per-message', async () => {
    await service.handleLeaseCreated(event);

    // The point of pinning these: a stored contract is a record, and one laid
    // out however the publisher felt that day cannot be reproduced.
    expect(render).toHaveBeenCalledWith(event.html, CONTRACT_PDF_OPTIONS);
    expect(CONTRACT_PDF_OPTIONS).toEqual({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
    });
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
});
