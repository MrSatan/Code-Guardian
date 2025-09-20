import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { ReviewJobData } from './dto/review.dto';
import { AIService } from '../ai/ai.service';
import type { VCS } from '../vcs/vcs.interface';
import { Inject } from '@nestjs/common';

@Processor('code-review')
export class ReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('VCS') private readonly vcsService: VCS,
    private readonly aiService: AIService,
  ) {
    super();
  }

  async process(job: Job<ReviewJobData, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id}...`);

    const { installationId, owner, repo, pullNumber, pullRequestId, commitSha } =
      job.data;

    const repository = await this.prisma.repository.findUnique({
      where: { installationId },
    });

    if (!repository) {
      throw new Error(`Repository with installationId ${installationId} not found.`);
    }

    const review = await this.prisma.review.create({
      data: {
        pullRequestNumber: pullNumber,
        pullRequestId: pullRequestId,
        commitSha,
        status: 'PENDING',
        repositoryId: repository.id,
      },
    });

    this.logger.log(`Created review ${review.id} for PR #${pullNumber}`);

    const diff = await this.vcsService.getPullRequestDiff(
      installationId,
      owner,
      repo,
      pullNumber,
    );

    this.logger.log(`Fetched diff for PR #${pullNumber}.`);

    const rules = await this.vcsService.getFileContent(
      installationId,
      owner,
      repo,
      '.codeguardian.yml',
      commitSha,
    );

    if (rules) {
      this.logger.log('Found .codeguardian.yml file with custom rules.');
    }

    const feedback = await this.aiService.analyzeDiff(diff, rules);

    this.logger.log(`Received ${feedback.length} feedback items from AI.`);

    for (const item of feedback) {
      await this.vcsService.postReviewComment(
        installationId,
        owner,
        repo,
        pullNumber,
        item.comment,
        item.file,
        item.line,
        commitSha,
      );
    }

    await this.prisma.review.update({
      where: { id: review.id },
      data: {
        status: 'COMPLETED',
        result: feedback as any, // Prisma expects JsonValue
      },
    });

    this.logger.log(`Review ${review.id} completed successfully.`);

    return { feedback };
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`Job ${job.id} has started.`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job, result: any) {
    this.logger.log(`Job ${job.id} has completed with result:`, result);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`Job ${job.id} has failed with error:`, err.stack);
  }
}
