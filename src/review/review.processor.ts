import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { ReviewJobData } from './dto/review.dto';
import { AIService, AIFeedback } from '../ai/ai.service';
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

    // Build validation map from diff (single parse, no additional API calls)
    const validationMap = this.buildValidationMap(diff);
    this.logger.log(`Built validation map with ${validationMap.files.size} files and ${Array.from(validationMap.fileLines.values()).reduce((sum, lines) => sum + lines.size, 0)} total line mappings`);

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

    // Track successful and failed comments separately
    const successfulComments: AIFeedback[] = [];
    const failedComments: Array<{ item: AIFeedback; error: string }> = [];

    // First pass: validate all comments locally (no API calls!)
    this.logger.log(`Validating ${feedback.length} comments locally...`);
    for (const item of feedback) {
      try {
        this.logger.log(`Validating comment for ${item.file}:${item.line}`);

        // Validate locally using pre-built validation map
        const isValidLine = this.validateCommentLocally(item, validationMap);

        if (!isValidLine) {
          const errorMsg = `Line ${item.line} in ${item.file} is not part of the actual diff`;
          this.logger.warn(`Skipping comment: ${errorMsg}`);
          failedComments.push({ item, error: errorMsg });
          continue;
        }

        // Comment is valid, add to successful list
        successfulComments.push(item);
        this.logger.log(`Comment validated: ${item.file}:${item.line}`);

      } catch (error) {
        // Validation failed
        const errorMsg = `Validation failed: ${error.message}`;
        this.logger.error(`Validation failed for ${item.file}:${item.line}:`, error.message);
        failedComments.push({ item, error: errorMsg });
        continue;
      }
    }

    // Second pass: batch post all valid comments
    if (successfulComments.length > 0) {
      try {
        this.logger.log(`Batch posting ${successfulComments.length} validated comments...`);

        // Convert AIFeedback to the format expected by batch API
        const batchComments = successfulComments.map(item => ({
          file: item.file,
          line: item.line,
          comment: item.comment,
          diffHunk: item.diffHunk,
        }));

        // Post all comments in a single batch
        await this.vcsService.postReviewCommentsBatch(
          installationId,
          owner,
          repo,
          pullNumber,
          batchComments,
          commitSha,
        );

        this.logger.log(`Successfully batch posted ${successfulComments.length} comments`);

      } catch (error) {
        // Batch posting failed - could fall back to individual posting
        this.logger.error(`Batch posting failed:`, error.message);

        // Optional: Fall back to individual posting for critical comments
        // For now, we'll mark all as failed since batch failed
        successfulComments.forEach(item => {
          failedComments.push({
            item,
            error: `Batch posting failed: ${error.message}`
          });
        });
        successfulComments.length = 0; // Clear successful list
      }
    }

    // Log summary of results
    this.logger.log(`Comment processing complete:`);
    this.logger.log(`- Successful: ${successfulComments.length}`);
    this.logger.log(`- Failed: ${failedComments.length}`);
    this.logger.log(`- Total: ${feedback.length}`);

    if (failedComments.length > 0) {
      this.logger.warn(`Failed comments:`);
      failedComments.forEach(({ item, error }) => {
        this.logger.warn(`  - ${item.file}:${item.line}: ${error}`);
      });
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

  private buildValidationMap(diff: string): {
    files: Set<string>;
    fileLines: Map<string, Set<number>>;
    diffHunks: Map<string, string[]>;
  } {
    const lines = diff.split('\n');
    const files = new Set<string>();
    const fileLines = new Map<string, Set<number>>();
    const diffHunks = new Map<string, string[]>();

    let currentFile = '';
    let currentHunkLines: string[] = [];
    let currentHunkStartLine = 0;
    let inHunk = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if we're entering a new file
      if (line.startsWith('diff --git')) {
        // Save previous file's data if exists
        if (currentFile && currentHunkLines.length > 0) {
          diffHunks.set(currentFile, [...(diffHunks.get(currentFile) || []), ...currentHunkLines]);
        }

        // Extract filename
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[1];
          files.add(currentFile);
          if (!fileLines.has(currentFile)) {
            fileLines.set(currentFile, new Set<number>());
          }
        }

        currentHunkLines = [];
        inHunk = false;
        continue;
      }

      // Parse hunk headers
      if (currentFile && line.startsWith('@@ ')) {
        // Save previous hunk if exists
        if (currentHunkLines.length > 0) {
          diffHunks.set(currentFile, [...(diffHunks.get(currentFile) || []), ...currentHunkLines]);
        }

        // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          currentHunkStartLine = parseInt(match[2]);
          currentHunkLines = [line]; // Include the hunk header
          inHunk = true;
        }
        continue;
      }

      // Process hunk content
      if (inHunk && currentFile) {
        currentHunkLines.push(line);

        // Track valid line numbers based on diff content
        const fileLinesSet = fileLines.get(currentFile)!;

        if (line.startsWith('+')) {
          // Addition line - corresponds to a new line in the file
          fileLinesSet.add(currentHunkStartLine);
          currentHunkStartLine++;
        } else if (line.startsWith(' ')) {
          // Context line - corresponds to existing line in both files
          fileLinesSet.add(currentHunkStartLine);
          currentHunkStartLine++;
        } else if (line.startsWith('-')) {
          // Deletion line - doesn't correspond to a line in the new file
          // Don't increment currentHunkStartLine
        }
        // Skip other lines (hunk headers, etc.)
      }
    }

    // Save final hunk if exists
    if (currentFile && currentHunkLines.length > 0) {
      diffHunks.set(currentFile, [...(diffHunks.get(currentFile) || []), ...currentHunkLines]);
    }

    return { files, fileLines, diffHunks };
  }

  private validateCommentLocally(
    item: AIFeedback,
    validationMap: {
      files: Set<string>;
      fileLines: Map<string, Set<number>>;
      diffHunks: Map<string, string[]>;
    }
  ): boolean {
    // Check if file exists in the diff
    if (!validationMap.files.has(item.file)) {
      this.logger.warn(`File ${item.file} does not exist in the diff`);
      return false;
    }

    // Check if line number is valid for this file
    const fileLines = validationMap.fileLines.get(item.file);
    if (!fileLines || !fileLines.has(item.line)) {
      this.logger.warn(`Line ${item.line} in ${item.file} is not part of the diff`);
      return false;
    }

    // Additional validation: ensure we have diff hunk context
    const fileHunks = validationMap.diffHunks.get(item.file);
    if (!fileHunks || fileHunks.length === 0) {
      this.logger.warn(`No diff hunks found for ${item.file}`);
      return false;
    }

    return true;
  }
}
