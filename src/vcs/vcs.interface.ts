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

  validateLineInDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    file: string,
    lineNumber: number,
  ): Promise<boolean>;

  postReviewCommentsBatch(
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
  ): Promise<void>;
}
