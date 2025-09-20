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

    // Use upsert to handle duplicate PR processing gracefully
    const review = await this.prisma.review.upsert({
      where: {
        pullRequestId: pullRequestId,
      },
      update: {
        // Reset status for reprocessing if it was previously failed/completed
        status: 'PENDING',
        commitSha, // Update with latest commit
        updatedAt: new Date(),
      },
      create: {
        pullRequestNumber: pullNumber,
        pullRequestId: pullRequestId,
        commitSha,
        status: 'PENDING',
        repositoryId: repository.id,
      },
    });

    // Log whether this was a new review or an existing one being reprocessed
    if (review.updatedAt && review.updatedAt > review.createdAt) {
      this.logger.log(`Reprocessing existing review ${review.id} for PR #${pullNumber}`);
    } else {
      this.logger.log(`Created new review ${review.id} for PR #${pullNumber}`);
    }

    // Update status to PROCESSING
    try {
      await this.prisma.review.update({
        where: { id: review.id },
        data: { status: 'PROCESSING' },
      });
    } catch (error) {
      this.logger.warn(`Failed to update review status to PROCESSING:`, error.message);
      // Continue processing anyway - this is not a critical error
    }

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

    this.logger.log(`Calling AI service to analyze diff...`);
    const feedback = await this.aiService.analyzeDiff(diff, rules);

    this.logger.log(`Received ${feedback.length} feedback items from AI.`);

    if (feedback.length === 0) {
      this.logger.warn(`No feedback received from AI for PR #${pullNumber}. This may indicate:`);
      this.logger.warn(`- Token limit exceeded for large diff`);
      this.logger.warn(`- AI processing failure`);
      this.logger.warn(`- Invalid JSON response from AI`);
      this.logger.warn(`- Check AI service logs for detailed error information`);
    }

    for (const item of feedback) {
      this.logger.log(`Posting comment for ${item.file}:${item.line}`);
      await this.vcsService.postReviewComment(
        installationId,
        owner,
        repo,
        pullNumber,
        item.comment,
        item.file,
        item.line,
        commitSha,
        item.diffHunk, // Include diff hunk context for GitHub API
      );
    }

    // Update review with results
    try {
      await this.prisma.review.update({
        where: { id: review.id },
        data: {
          status: 'COMPLETED',
          result: feedback as any, // Prisma expects JsonValue
        },
      });
      this.logger.log(`Review ${review.id} completed successfully.`);
    } catch (error) {
      this.logger.error(`Failed to update review ${review.id} to COMPLETED:`, error.message);
      // Don't throw here - the review was processed successfully, just the DB update failed
      this.logger.log(`Review processing completed but database update failed for review ${review.id}`);
    }

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
