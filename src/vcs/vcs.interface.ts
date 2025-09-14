export enum VcsProvider {
  GitHub = 'github',
  GitLab = 'gitlab',
}

export interface VersionControlService {
  readonly provider: VcsProvider;
  handlePullRequestEvent(payload: any): Promise<void>;
  handleInstallationEvent(payload: any): Promise<void>;
}
