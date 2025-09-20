export interface ReviewJobData {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  pullRequestId: number;
  commitSha: string;
}
