import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VersionControlService, VcsProvider } from '../vcs.interface';

@Injectable()
export class GithubService implements VersionControlService {
  readonly provider = VcsProvider.GitHub;

  constructor(@InjectQueue('code-review') private readonly codeReviewQueue: Queue) {}

  async handlePullRequestEvent(payload: any): Promise<void> {
    const { action, pull_request, installation } = payload;

    if (action !== 'opened' && action !== 'synchronize') {
      return;
    }

    const jobPayload = {
      installationId: installation.id,
      owner: pull_request.head.repo.owner.login,
      repo: pull_request.head.repo.name,
      pull_number: pull_request.number,
      commit_sha: pull_request.head.sha,
      provider: this.provider,
    };

    await this.codeReviewQueue.add('code-review', jobPayload);
  }

  async handleInstallationEvent(payload: any): Promise<void> {
    // This is where you would handle the app installation event.
    // For now, we'll just log it.
    console.log('Installation event received:', payload);
  }
}
