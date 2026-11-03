import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentKind, FeelingLabel, Prisma, ResourceCategory } from '@prisma/client';
import { ContentService } from '../content/content.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { ResourceFeedbackDto } from './dto/resource-feedback.dto.js';
import type { ResourceQueryDto } from './dto/resource-query.dto.js';

/**
 * The only check-in feelings with an approved resource grouping (Doc B / G13).
 * Anything outside this map gets the neutral "featured" surface instead of a
 * personalisation claim, because no mapping has been reviewed for it.
 */
const STATED_NEED_CATEGORIES: ResourceCategory[] = [
  ResourceCategory.EXAM_STRESS,
  ResourceCategory.GROUNDING,
  ResourceCategory.ANXIETY,
];

const STATED_NEED_LABELS: Partial<Record<FeelingLabel, string>> = {
  OVERWHELMED: 'overwhelmed',
  ANXIOUS: 'anxious',
  STRESSED: 'stressed',
};

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly contentService: ContentService,
  ) {}

  /**
   * The one definition of "a student may see this" (Doc B §5, Doc C §1).
   *
   * `approved` on the row is a publisher's intention; the content register is
   * the review record, and a resource needs both. A row with no `contentCode`
   * can therefore never appear: nothing has reviewed a string that was never
   * registered, which is precisely the promise "reviewed and approved before
   * students see it" makes to a student — and precisely what the five seeded
   * placeholder rows used to break while they carried `approved: true`.
   *
   * An empty set is a real answer, not a bug to guard: `contentCode: { in: [] }`
   * matches nothing, so an unapproved register empties the catalogue rather
   * than falling back to the boolean.
   */
  private async visibleWhere(): Promise<Prisma.WellbeingResourceWhereInput> {
    const codes = await this.contentService.liveCodes({
      kind: ContentKind.WELLBEING_RESOURCE,
    });
    return { active: true, approved: true, contentCode: { in: [...codes] } };
  }

  async list(userId: string, query: ResourceQueryDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const where: Prisma.WellbeingResourceWhereInput = {
      ...(await this.visibleWhere()),
      ...(query.category ? { category: query.category } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    if (query.savedOnly === 'true') {
      where.toolboxItems = { some: { studentId: student.id } };
    }
    const items = await this.prisma.wellbeingResource.findMany({
      where,
      orderBy: { title: 'asc' },
    });
    const savedCount = await this.prisma.toolboxItem.count({
      where: { studentId: student.id },
    });
    return { items, savedCount };
  }

  /**
   * Doc B §2 allows the words "Picked for you" only when a stated need or a
   * chosen category drove the selection, so the response says which of the two
   * rules actually fired. Without that flag a surface would have to read its
   * own title to know whether it is allowed to claim personalisation.
   *
   * The newest check-in is resolved here rather than passed in: a student does
   * not know their check-in ids, and a client that had to supply one would
   * quietly turn "from your check-in" into a claim it invented.
   */
  async tailored(userId: string, checkInId?: string) {
    const student = await this.studentsService.ensureProfile(userId);
    let where: Prisma.WellbeingResourceWhereInput = await this.visibleWhere();
    let title = 'Featured resources';
    let rationale = 'The newest approved resources, in case you want something to try.';
    let basis: 'STATED_NEED' | 'NEWEST_APPROVED' = 'NEWEST_APPROVED';

    const checkIn = checkInId
      ? await this.prisma.emotionalCheckIn.findFirst({
          where: { id: checkInId, studentId: student.id },
        })
      : await this.prisma.emotionalCheckIn.findFirst({
          where: { studentId: student.id },
          orderBy: { createdAt: 'desc' },
        });
    const statedNeed = checkIn ? STATED_NEED_LABELS[checkIn.feeling] : undefined;
    if (statedNeed) {
      where = { ...where, OR: STATED_NEED_CATEGORIES.map((category) => ({ category })) };
      title = 'Picked for you';
      rationale = `You said you feel ${statedNeed}, so these are the exam-stress, anxiety and grounding resources.`;
      basis = 'STATED_NEED';
    }

    const items = await this.prisma.wellbeingResource.findMany({
      where,
      take: 3,
      orderBy: { updatedAt: 'desc' },
    });
    return { title, rationale, basis, items };
  }

  async toolbox(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const codes = await this.contentService.liveCodes({
      kind: ContentKind.WELLBEING_RESOURCE,
    });
    const rows = await this.prisma.toolboxItem.findMany({
      where: { studentId: student.id },
      include: { resource: true },
      orderBy: { createdAt: 'desc' },
    });
    // A save outlives the review that allowed it. The student keeps the row
    // only while the register still approves the resource inside it.
    const items = rows
      .map((r) => r.resource)
      .filter(
        (resource) =>
          resource.active &&
          resource.approved &&
          resource.contentCode !== null &&
          codes.has(resource.contentCode),
      );
    return { items, count: items.length };
  }

  async saveToolbox(userId: string, resourceId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const resource = await this.prisma.wellbeingResource.findFirst({
      where: { id: resourceId, ...(await this.visibleWhere()) },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    await this.prisma.toolboxItem.upsert({
      where: {
        studentId_resourceId: { studentId: student.id, resourceId },
      },
      create: { studentId: student.id, resourceId },
      update: {},
    });
    return this.toolbox(userId);
  }

  /**
   * US-WR-D06. Writes one feedback row and nothing else: Doc C §5.1 forbids a
   * resource click, a "not helpful" or a refusal from becoming risk signal.
   */
  async recordFeedback(userId: string, body: ResourceFeedbackDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const resource = await this.prisma.wellbeingResource.findFirst({
      where: { id: body.resourceId, ...(await this.visibleWhere()) },
      select: { id: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    await this.prisma.resourceFeedback.create({
      data: {
        studentId: student.id,
        resourceId: resource.id,
        choice: body.choice,
      },
    });
    return { recorded: true };
  }
}
