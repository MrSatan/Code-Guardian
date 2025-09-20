import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App } from 'octokit';
import { VCS } from '../vcs.interface';
import { PrismaService } from '../../database/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class GithubService implements VCS {
  private readonly logger = new Logger(GithubService.name);
  private readonly app: App;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @InjectQueue('code-review') private readonly codeReviewQueue: Queue,
  ) {
    const appId = this.configService.get<string>('GITHUB_APP_ID');
    const privateKey = this.configService.get<string>('GITHUB_PRIVATE_KEY');

    if (!appId || !privateKey) {
      throw new Error('GitHub App ID and Private Key must be configured.');
    }

    this.app = new App({
      appId,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    });
  }

  async getPullRequestDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<string> {
    this.logger.log(
      `Fetching diff for PR #${pullNumber} in ${owner}/${repo} (installation ${installationId})`,
    );

    try {
      const octokit = await this.app.getInstallationOctokit(installationId);

      const response = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo,
          pull_number: pullNumber,
          headers: {
            accept: 'application/vnd.github.v3.diff',
          },
        },
      );

      return response.data as unknown as string;
    } catch (error) {
      this.logger.error(
        `Failed to fetch diff for PR #${pullNumber} in ${owner}/${repo}`,
        error.stack,
      );
      throw new Error('Could not fetch pull request diff from GitHub.');
    }
  }

  async postReviewComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    comment: string,
    file: string,
    lineNumber: number,
    commitId: string,
    diffHunk?: string,
  ): Promise<void> {
    this.logger.log(
      `Posting comment to PR #${pullNumber} in ${owner}/${repo} on ${file}:${lineNumber}`,
    );

    try {
      const octokit = await this.app.getInstallationOctokit(installationId);

      const commentData: any = {
        owner,
        repo,
        pull_number: pullNumber,
        body: comment,
        path: file,
        line: lineNumber,
        commit_id: commitId,
      };

      // Add diff_hunk if provided (required for accurate line positioning)
      if (diffHunk) {
        commentData.diff_hunk = diffHunk;
        this.logger.log(`Including diff_hunk for accurate line positioning`);
      }

      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
        commentData,
      );

      this.logger.log(`Successfully posted comment on ${file}:${lineNumber}`);
    } catch (error) {
      this.logger.error(
        `Failed to post comment to PR #${pullNumber} in ${owner}/${repo}`,
        error.stack,
      );

      // Provide more specific error information
      if (error.message?.includes('line must be part of the diff')) {
        this.logger.error(`Line ${lineNumber} in ${file} is not part of the actual diff. This may be due to chunking.`);
      }
      if (error.message?.includes('diff_hunk')) {
        this.logger.error(`Missing diff_hunk context for line ${lineNumber} in ${file}.`);
      }

      throw new Error('Could not post comment to GitHub.');
    }
  }

  async getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    commitId: string,
  ): Promise<string | null> {
    this.logger.log(
      `Fetching content of ${path} in ${owner}/${repo} at commit ${commitId}`,
    );

    try {
      const octokit = await this.app.getInstallationOctokit(installationId);

      const response = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner,
          repo,
          path,
          ref: commitId,
        },
      );

      if ('content' in response.data) {
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }

      return null;
    } catch (error) {
      if (error.status === 404) {
        this.logger.warn(
          `File not found: ${path} in ${owner}/${repo} at commit ${commitId}`,
        );
        return null;
      }

      this.logger.error(
        `Failed to fetch content of ${path} in ${owner}/${repo}`,
        error.stack,
      );
      throw new Error('Could not fetch file content from GitHub.');
    }
  }

  async handlePullRequestEvent(payload: any): Promise<void> {
    if (payload.action !== 'opened' && payload.action !== 'synchronize') {
      this.logger.log(
        `Ignoring pull request event with action: ${payload.action}`,
      );
      return;
    }

    const { pull_request, repository, installation } = payload;

    const job = {
      installationId: installation.id,
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pull_request.number,
      pullRequestId: pull_request.id,
      commitSha: pull_request.head.sha,
    };

    await this.codeReviewQueue.add('code-review', job);
    this.logger.log(`Added job to code-review queue: ${JSON.stringify(job)}`);
  }

  async validateLineInDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    file: string,
    lineNumber: number,
  ): Promise<boolean> {
    this.logger.log(
      `Validating if line ${lineNumber} in ${file} is part of PR #${pullNumber} diff`,
    );

    try {
      // Get the diff for this PR
      const diff = await this.getPullRequestDiff(installationId, owner, repo, pullNumber);

      // Parse the diff to find hunks for the specific file
      const lines = diff.split('\n');
      let inTargetFile = false;
      let currentHunkStartLine = 0;
      let currentHunkNewStart = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if we're entering the target file
        if (line.startsWith('diff --git') && line.includes(file)) {
          inTargetFile = true;
          continue;
        }

        // If we hit another file's diff, we're done with this file
        if (line.startsWith('diff --git') && inTargetFile && !line.includes(file)) {
          break;
        }

        // Parse hunk headers for the target file
        if (inTargetFile && line.startsWith('@@ ')) {
          // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
          const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
          if (match) {
            currentHunkNewStart = parseInt(match[2]);
            currentHunkStartLine = i;
          }
        }

        // Check if we're in a hunk and this line affects our target line
        if (inTargetFile && currentHunkNewStart > 0) {
          const relativeLineInHunk = i - currentHunkStartLine;

          // Skip the hunk header line
          if (relativeLineInHunk === 0) continue;

          // Check if this line in the hunk corresponds to our target line
          let currentLineInFile = currentHunkNewStart;
          let hunkLineIndex = 1; // Start after hunk header

          // Count through the hunk lines to see which file line they correspond to
          while (hunkLineIndex <= relativeLineInHunk && i + hunkLineIndex - relativeLineInHunk < lines.length) {
            const hunkLine = lines[currentHunkStartLine + hunkLineIndex];

            if (hunkLine.startsWith('+')) {
              // Addition line - this corresponds to a line in the new file
              if (currentLineInFile === lineNumber) {
                this.logger.log(`Line ${lineNumber} in ${file} is a valid addition in the diff`);
                return true;
              }
              currentLineInFile++;
            } else if (hunkLine.startsWith('-')) {
              // Deletion line - this doesn't correspond to a line in the new file
              // Don't increment currentLineInFile
            } else if (hunkLine.startsWith(' ')) {
              // Context line - this corresponds to a line in both files
              if (currentLineInFile === lineNumber) {
                this.logger.log(`Line ${lineNumber} in ${file} is a valid context line in the diff`);
                return true;
              }
              currentLineInFile++;
            }
            // Skip other lines (like hunk headers we've already processed)

            hunkLineIndex++;
          }
        }
      }

      this.logger.log(`Line ${lineNumber} in ${file} is NOT part of the diff`);
      return false;
    } catch (error) {
      this.logger.error(
        `Failed to validate line ${lineNumber} in ${file} for PR #${pullNumber}`,
        error.stack,
      );
      // If we can't validate, err on the side of caution and return false
      return false;
    }
  }

  async postReviewCommentsBatch(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    comments: Array<{
      file: string;
      line: number;
      comment: string;
      diffHunk?: string;
    }>,
    commitId: string,
  ): Promise<void> {
    this.logger.log(
      `Posting ${comments.length} comments in batch to PR #${pullNumber} in ${owner}/${repo}`,
    );

    if (comments.length === 0) {
      this.logger.log('No comments to post in batch');
      return;
    }

    try {
      const octokit = await this.app.getInstallationOctokit(installationId);

      // Prepare comments for GitHub API
      const githubComments = comments.map(comment => ({
        path: comment.file,
        line: comment.line,
        body: comment.comment,
        ...(comment.diffHunk && { diff_hunk: comment.diffHunk }),
      }));

      // Use GitHub's "Create a review" endpoint for batch commenting
      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        {
          owner,
          repo,
          pull_number: pullNumber,
          body: `AI Code Review - ${comments.length} comments`,
          event: 'COMMENT',
          comments: githubComments,
          commit_id: commitId,
        },
      );

      this.logger.log(`Successfully posted ${comments.length} comments in batch to PR #${pullNumber}`);

    } catch (error) {
      this.logger.error(
        `Failed to post ${comments.length} comments in batch to PR #${pullNumber} in ${owner}/${repo}`,
        error.stack,
      );

      // Provide more specific error information
      if (error.message?.includes('line must be part of the diff')) {
        this.logger.error(`Some comments reference lines that are not part of the diff`);
      }
      if (error.message?.includes('diff_hunk')) {
        this.logger.error(`Missing diff_hunk context for some comments`);
      }

      throw new Error(`Could not post ${comments.length} comments in batch to GitHub.`);
    }
  }

  async handleInstallationEvent(payload: any): Promise<void> {
    const { action, installation, repositories } = payload;

    if (action === 'created') {
      for (const repo of repositories) {
        await this.prisma.repository.create({
          data: {
            githubRepoId: repo.id,
            name: repo.full_name,
            installationId: installation.id,
          },
        });
        this.logger.log(`Installed on repository: ${repo.full_name}`);
      }
    } else if (action === 'deleted') {
      await this.prisma.repository.update({
        where: {
          installationId: installation.id,
        },
        data: {
          isActive: false,
        },
      });
      this.logger.log(`Uninstalled from repository`);
    } else {
      this.logger.log(`Ignoring installation event with action: ${action}`);
    }
  }
}
