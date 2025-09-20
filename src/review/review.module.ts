import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReviewProcessor } from './review.processor';
import { PrismaModule } from '../database/prisma.module';
import { VCSModule } from '../vcs/vcs.module';
import { GithubService } from '../vcs/github/github.service';
import { AIModule } from '../ai/ai.module';

@Module({
  imports: [
    PrismaModule,
    VCSModule,
    AIModule,
    BullModule.registerQueue({
      name: 'code-review',
    }),
  ],
  providers: [
    ReviewProcessor,
    {
      provide: 'VCS',
      useClass: GithubService,
    },
  ],
})
export class ReviewModule {}
