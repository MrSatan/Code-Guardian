import { Controller, Post, Headers, Body, BadRequestException, Logger } from '@nestjs/common';
import { GithubService } from './github/github.service';

@Controller('vcs')
export class VcsController {
  private readonly logger = new Logger(VcsController.name);
  constructor(private readonly githubService: GithubService) {}

  @Post('webhook')
  async handleWebhook(@Headers() headers: any, @Body() body: any) {
    this.logger.log(`Incoming webhook for event: ${headers['x-github-event']}`);
    if (headers['x-github-event']) {
      const event = headers['x-github-event'];
      if (event === 'pull_request') {
        await this.githubService.handlePullRequestEvent(body);
      } else if (event === 'installation') {
        await this.githubService.handleInstallationEvent(body);
      }
    } else {
      throw new BadRequestException('Unsupported VCS provider');
    }
  }
}
