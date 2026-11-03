import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  ContentKind,
  ContentStatus,
  type ContentItem,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

interface ResolveInput {
  kind: ContentKind;
  codes: string[];
  ageBand?: string | null;
  locale?: string;
  /** Injectable clock so the effective-window rule is testable without waiting. */
  now?: Date;
}

/**
 * The content register (Doc C §6/§7). Every reviewer-editable string is a
 * versioned row here; nothing reaches a surface until an authorised reviewer
 * approves THAT exact version. `resolve` is the only read other services use:
 * it hands back APPROVED_ACTIVE rows whose effective window contains `now`,
 * and it treats a request for a BLOCKED code as a refusal (403), never a
 * silent empty — a caller must not mistake "blocked pending safeguarding
 * review" for "there is no such content".
 */
@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ResolveInput): Promise<ContentItem[]> {
    if (input.codes.length === 0) return [];
    const locale = input.locale ?? 'en';
    const now = input.now ?? new Date();

    const rows = await this.prisma.contentItem.findMany({
      where: { kind: input.kind, code: { in: input.codes }, locale },
    });

    const blocked = rows.filter((r) => r.status === ContentStatus.BLOCKED);
    if (blocked.length > 0) {
      throw new ForbiddenException(
        `Content ${blocked.map((b) => b.code).join(', ')} is BLOCKED pending safeguarding approval`,
      );
    }

    const live = rows.filter(
      (r) =>
        r.status === ContentStatus.APPROVED_ACTIVE &&
        (!r.effectiveFrom || r.effectiveFrom.getTime() <= now.getTime()) &&
        (!r.effectiveTo || r.effectiveTo.getTime() > now.getTime()),
    );

    // Age-band-specific wording wins over an all-bands row for the same code;
    // bands change wording only, never meaning (Doc C §2), so both may exist.
    const byCode = new Map<string, ContentItem>();
    for (const row of live) {
      const current = byCode.get(row.code);
      const exact = Boolean(row.ageBand) && row.ageBand === input.ageBand;
      if (!current || (exact && current.ageBand !== input.ageBand)) {
        byCode.set(row.code, row);
      }
    }

    return input.codes
      .map((code) => byCode.get(code))
      .filter((row): row is ContentItem => Boolean(row));
  }

  /**
   * Capture-side gate, narrower than `resolve`: a prompt is *askable* only once
   * it is registered and past DRAFT, and a BLOCKED code (CP-09…CP-17) is a 403
   * refusal rather than a silent skip, so no surface can start collecting
   * answers to a question that safeguarding review has withheld.
   */
  async assertAskable(codes: string[]): Promise<void> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return;
    const rows = await this.prisma.contentItem.findMany({
      where: { code: { in: unique } },
      select: { code: true, status: true },
    });
    const byCode = new Map(rows.map((row) => [row.code, row.status]));
    const askable: ContentStatus[] = [
      ContentStatus.CONTENT_REVIEW_REQUIRED,
      ContentStatus.APPROVED_ACTIVE,
    ];
    const refused = unique.filter(
      (code) => !askable.includes(byCode.get(code) as ContentStatus),
    );
    if (refused.length > 0) {
      throw new ForbiddenException(
        `Content ${refused.join(', ')} is not askable: unregistered, draft, or withheld by review`,
      );
    }
  }

  /**
   * The codes of a whole kind that may be shown right now.
   *
   * `resolve` answers "give me THESE codes", which needs a caller that already
   * knows them. A catalogue does not: it must ask the register what is live and
   * then read only those rows, so the SQL filter and the returned count are
   * built from one predicate instead of filtering after the fact.
   *
   * A BLOCKED row vetoes its code even when an approved version exists —
   * safeguarding withdrawal outranks the version trail. SUPERSEDED and RETIRED
   * rows do not veto, because every live version carries a history of them; a
   * code that is merely retired has no APPROVED_ACTIVE row and drops out on its
   * own. Age band does not gate a code: bands change wording only (Doc C §2).
   */
  async liveCodes(input: {
    kind: ContentKind;
    locale?: string;
    now?: Date;
  }): Promise<Set<string>> {
    const locale = input.locale ?? 'en';
    const now = input.now ?? new Date();

    const rows = await this.prisma.contentItem.findMany({
      where: { kind: input.kind, locale },
      select: {
        code: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });

    const vetoed = new Set(
      rows.filter((r) => r.status === ContentStatus.BLOCKED).map((r) => r.code),
    );

    const live = new Set<string>();
    for (const row of rows) {
      if (vetoed.has(row.code)) continue;
      if (row.status !== ContentStatus.APPROVED_ACTIVE) continue;
      if (row.effectiveFrom && row.effectiveFrom.getTime() > now.getTime()) continue;
      if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) continue;
      live.add(row.code);
    }
    return live;
  }

  /** The register as a table, for the PLATFORM_ADMIN view and the rollback drill. */
  list(filter: {
    kind?: ContentKind;
    status?: ContentStatus;
    locale?: string;
  }): Promise<ContentItem[]> {
    return this.prisma.contentItem.findMany({
      where: {
        kind: filter.kind,
        status: filter.status,
        locale: filter.locale,
      },
      orderBy: [
        { code: 'asc' },
        { majorVersion: 'desc' },
        { minorVersion: 'desc' },
        { patchVersion: 'desc' },
      ],
    });
  }
}
