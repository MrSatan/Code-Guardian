import { Controller, Post, Headers, Body, BadRequestException } from '@nestjs/common';
import { GithubService } from './github/github.service';

@Controller('vcs')
export class VcsController {
  constructor(private readonly githubService: GithubService) {}

  @Post('webhook')
  async handleWebhook(@Headers() headers: any, @Body() body: any) {
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
