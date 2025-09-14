import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VcsController } from './vcs.controller';
import { GithubService } from './github/github.service';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({
      name: 'code-review',
    }),
  ],
  controllers: [VcsController],
  providers: [GithubService],
})
export class VcsModule {}
