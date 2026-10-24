import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AiReportReviewOutcome, Prisma } from '@prisma/client';
import { REVIEWER_ROLES } from '../common/guards/roles.decorator.js';
import { inSchool } from '../common/tenant/school-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateAiResponseReportDto, ListAiResponseReportsDto } from './dto/ai-response-report.dto.js';

const baseSelect = {
  id: true, messageId: true, responseContent: true, responseLanguage: true, note: true, createdAt: true,
  message: { select: { conversationId: true } },
} satisfies Prisma.AiResponseReportSelect;

/** Reviewer projection — the decision belongs to the school's reviewers. */
const reportSelect = {
  ...baseSelect,
  reviewOutcome: true, reviewedAt: true,
  reviewedBy: { select: { name: true, role: true } },
} satisfies Prisma.AiResponseReportSelect;

/** Student projection — a submission or retry must never reveal that a
 * reviewer looked at the report, what they concluded, or who they are. */
const submissionSelect = baseSelect;

type SelectedReport = Prisma.AiResponseReportGetPayload<{ select: typeof reportSelect }>;
type SubmittedReport = Prisma.AiResponseReportGetPayload<{ select: typeof submissionSelect }>;
const toView = <T extends { message: { conversationId: string } }>({ message, ...report }: T) => ({
  ...report, conversationId: message.conversationId,
});
const reportView = (report: SelectedReport) => toView(report);
const submissionView = (report: SubmittedReport) => toView(report);

@Injectable()
export class AiResponseReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async studentActor(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, schoolId: true } });
    if (user?.role !== 'STUDENT') throw new ForbiddenException();
    return user;
  }

  private async reviewerSchool(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, schoolId: true } });
    if (!user || !REVIEWER_ROLES.some((role) => role === user.role)) throw new ForbiddenException();
    if (!user.schoolId) throw new NotFoundException('Report not found');
    return user.schoolId;
  }

  async submit(userId: string, dto: CreateAiResponseReportDto) {
    const user = await this.studentActor(userId);
    if (!user.schoolId) {
      throw new ForbiddenException('Your account must be linked to a school to submit a report.');
    }
    const owner = { student: { userId, user: { role: 'STUDENT' as const, schoolId: user.schoolId } } };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const message = await tx.conversationMessage.findFirst({
          where: { id: dto.messageId, role: 'ASSISTANT', conversation: owner },
          select: { id: true, content: true, language: true },
        });
        if (!message) throw new NotFoundException('Response not found');
        const existing = await tx.aiResponseReport.findUnique({ where: { messageId: message.id }, select: submissionSelect });
        if (existing) return { report: submissionView(existing), alreadyReported: true };
        if (message.content !== dto.expectedContent) {
          throw new ConflictException({ message: 'This reply has changed. Reload the conversation and select the reply again.', code: 'RESPONSE_CHANGED' });
        }
        // Async generation replaces message content in place; the reported text must stay fixed.
        const report = await tx.aiResponseReport.create({
          data: { messageId: message.id, responseContent: message.content, responseLanguage: message.language, note: dto.note?.trim() ? dto.note : null },
          select: submissionSelect,
        });
        await tx.auditLog.create({ data: {
          actorId: userId, schoolId: user.schoolId, action: 'ai_response_report.created', entity: 'AiResponseReport', entityId: report.id,
        } });
        return { report: submissionView(report), alreadyReported: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.aiResponseReport.findFirst({
          where: { messageId: dto.messageId, message: { conversation: owner } }, select: submissionSelect,
        });
        if (existing) return { report: submissionView(existing), alreadyReported: true };
      }
      throw error;
    }
  }

  async mine(userId: string, conversationId: string) {
    await this.studentActor(userId);
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, student: { userId, user: { role: 'STUDENT' } } }, select: { id: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    const items = await this.prisma.aiResponseReport.findMany({
      where: { message: { conversationId: conversation.id } },
      select: { id: true, messageId: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items };
  }

  async list(userId: string, { limit, offset }: ListAiResponseReportsDto) {
    const schoolId = await this.reviewerSchool(userId);
    const rows = await this.prisma.aiResponseReport.findMany({
      where: { message: { conversation: inSchool(schoolId) } },
      select: reportSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, skip: offset,
    });
    return { items: rows.slice(0, limit).map(reportView), nextOffset: rows.length > limit ? offset + limit : null };
  }

  async getOne(userId: string, id: string) {
    const schoolId = await this.reviewerSchool(userId);
    return this.sameSchoolReport(id, schoolId);
  }

  /**
   * Record-only review: the decision, the reviewer and the timestamp are
   * written on the report and audited. Nothing here touches the AI's reply,
   * the student's conversation, memory, or the reported text itself.
   */
  async review(userId: string, id: string, outcome: AiReportReviewOutcome) {
    const schoolId = await this.reviewerSchool(userId);
    const current = await this.prisma.aiResponseReport.findFirst({
      where: { id, message: { conversation: inSchool(schoolId) } },
      select: { id: true, reviewOutcome: true, reviewedById: true },
    });
    if (!current) throw new NotFoundException('Report not found');
    if (current.reviewOutcome === outcome && current.reviewedById === userId) {
      return this.sameSchoolReport(current.id, schoolId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.aiResponseReport.update({
        where: { id: current.id },
        data: { reviewOutcome: outcome, reviewedById: userId, reviewedAt: new Date() },
      });
      await tx.auditLog.create({ data: {
        actorId: userId, schoolId, action: 'ai_response_report.review_recorded',
        entity: 'AiResponseReport', entityId: current.id, meta: { outcome },
      } });
    });
    return this.sameSchoolReport(current.id, schoolId);
  }

  /** Every reviewer read resolves through the actor's school, so a foreign or
   *  withdrawn row answers 404 and confirms nothing about another tenant. */
  private async sameSchoolReport(id: string, schoolId: string) {
    const report = await this.prisma.aiResponseReport.findFirst({
      where: { id, message: { conversation: inSchool(schoolId) } }, select: reportSelect,
    });
    if (!report) throw new NotFoundException('Report not found');
    return reportView(report);
  }
}
