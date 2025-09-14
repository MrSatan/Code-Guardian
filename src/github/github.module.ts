import { Module } from '@nestjs/common';
import { GithubService } from './github.service';
import { QueueModule } from 'src/queue/queue.module';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({
      name: 'code-review',
    }),
  ],
  providers: [GithubService],
})
export class GithubModule {}
