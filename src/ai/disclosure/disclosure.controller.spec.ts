import { BadRequestException } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../../audit/audit.service.js';
import { ConsentService } from '../../consent/consent.service.js';
import {
  AI_DISCLOSURE_AGREEMENT_IDS,
  AI_DISCLOSURE_CONSENT_VERSION,
  AI_DISCLOSURE_VERSION,
} from './ai-disclosure.js';
import { AiDisclosureController } from './disclosure.controller.js';

describe('AiDisclosureController', () => {
  let controller: AiDisclosureController;
  let consentService: {
    status: ReturnType<typeof vi.fn>;
    accept: ReturnType<typeof vi.fn>;
  };
  let auditService: { log: ReturnType<typeof vi.fn> };

  const session = { user: { id: 'user-1' } } as UserSession;
  const record = { id: 'consent-1', version: AI_DISCLOSURE_CONSENT_VERSION };

  beforeEach(() => {
    consentService = {
      status: vi.fn().mockResolvedValue({
        version: AI_DISCLOSURE_CONSENT_VERSION,
        accepted: false,
        acceptedAt: null,
      }),
      accept: vi.fn().mockResolvedValue(record),
    };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
    controller = new AiDisclosureController(
      consentService as unknown as ConsentService,
      auditService as unknown as AuditService,
    );
  });

  it('serves both disclosure groups and every agreement the client must tick', () => {
    const view = controller.view();

    expect(view.version).toBe(AI_DISCLOSURE_VERSION);
    expect(view.consentVersion).toBe(AI_DISCLOSURE_CONSENT_VERSION);
    expect(view.groups.map((g) => g.id)).toEqual([
      'read-before-you-start',
      'about-this-chat',
    ]);
    expect(view.agreements.map((a) => a.id)).toEqual(AI_DISCLOSURE_AGREEMENT_IDS);
    // The plain-text fallback is what gets logged/audited and read by screen
    // readers, so it must carry every section, not just the headings.
    expect(view.text).toContain('Read before you start');
    expect(view.text).toContain('About this chat');
  });

  it('reports the signed-in students status against the current version', async () => {
    await controller.status(session);

    expect(consentService.status).toHaveBeenCalledWith(
      'user-1',
      AI_DISCLOSURE_CONSENT_VERSION,
    );
  });

  it('rejects a partial acceptance without writing a consent record', async () => {
    const partial = AI_DISCLOSURE_AGREEMENT_IDS.slice(0, -1);

    await expect(
      controller.acknowledge(session, { agreements: partial }),
    ).rejects.toThrow(BadRequestException);

    expect(consentService.accept).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('rejects an agreement id that is not part of this disclosure', async () => {
    await expect(
      controller.acknowledge(session, {
        agreements: [...AI_DISCLOSURE_AGREEMENT_IDS, 'i-am-a-robot'],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(consentService.accept).not.toHaveBeenCalled();
  });

  it('records the acceptance and the audit trail once every statement is ticked', async () => {
    const result = await controller.acknowledge(session, {
      agreements: [...AI_DISCLOSURE_AGREEMENT_IDS].reverse(),
    });

    expect(result).toEqual({ acknowledged: true, record });
    // Metadata is built server-side, so a reordered or duplicated client list
    // still stores the canonical statements for this version.
    expect(consentService.accept).toHaveBeenCalledWith(
      'user-1',
      AI_DISCLOSURE_CONSENT_VERSION,
      {
        disclosureVersion: AI_DISCLOSURE_VERSION,
        agreements: AI_DISCLOSURE_AGREEMENT_IDS,
      },
    );
    expect(auditService.log).toHaveBeenCalledWith({
      actorId: 'user-1',
      action: 'ai.disclosure_acknowledged',
      entity: 'ConsentRecord',
      entityId: 'consent-1',
      meta: {
        version: AI_DISCLOSURE_CONSENT_VERSION,
        agreements: AI_DISCLOSURE_AGREEMENT_IDS,
      },
    });
  });
});
