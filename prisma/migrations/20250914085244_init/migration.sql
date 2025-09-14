CREATE TYPE "public"."Status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "public"."Repository" (
    "id" SERIAL NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Review" (
    "id" SERIAL NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "pullRequestId" BIGINT NOT NULL,
    "status" "public"."Status" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "commitSha" TEXT NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Repository_githubRepoId_key" ON "public"."Repository"("githubRepoId");

CREATE UNIQUE INDEX "Repository_installationId_key" ON "public"."Repository"("installationId");

CREATE UNIQUE INDEX "Review_pullRequestId_key" ON "public"."Review"("pullRequestId");

CREATE INDEX "Review_repositoryId_idx" ON "public"."Review"("repositoryId");

ALTER TABLE "public"."Review" ADD CONSTRAINT "Review_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "public"."Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
