import { buildObjectKey } from './object-key';

/**
 * The object key is the only string this worker invents, and it is the one the
 * requester will store and later read back. These tests are about the ways that
 * goes wrong badly — a collision, or a supplied name escaping its prefix.
 */
describe('buildObjectKey', () => {
  it('nests a document under its organization and subject', () => {
    const key = buildObjectKey({
      organizationId: 'org_1',
      subjectType: 'LEASE',
      subjectId: 'lease_1',
      extension: '.pdf',
    });

    expect(key).toMatch(
      /^organizations\/org_1\/leases\/lease_1\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it('files a subjectless document against the organization itself', () => {
    const key = buildObjectKey({
      organizationId: 'org_1',
      subjectType: 'ORGANIZATION',
      subjectId: null,
      extension: '.pdf',
    });

    expect(key).toMatch(
      /^organizations\/org_1\/organization\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it('treats a subject type it has never heard of as a path segment', () => {
    // A new subject on the app's side must not need a deploy on this one.
    const key = buildObjectKey({
      organizationId: 'org_1',
      subjectType: 'INSPECTION',
      subjectId: 'insp_1',
      extension: '.pdf',
    });

    expect(key).toContain('/inspection/insp_1/');
  });

  it('never reuses a key for the same subject', () => {
    const input = {
      organizationId: 'org_1',
      subjectType: 'LEASE',
      subjectId: 'lease_1',
      extension: '.pdf',
    };

    // Two organizations both filing `contract-L-7F3QA.pdf` must not overwrite
    // one another — which is why the object is named by a uuid, not by the
    // fileName the requester sent.
    expect(buildObjectKey(input)).not.toBe(buildObjectKey(input));
  });
});
