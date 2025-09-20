export interface VCS {
  getPullRequestDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<string>;

  postReviewComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    comment: string,
    file: string,
    lineNumber: number,
    commitId: string,
    diffHunk?: string,
  ): Promise<void>;

  getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    commitId: string,
  ): Promise<string | null>;
}
