import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { GithubService } from './github.service';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    QueueModule,
    BullModule.registerQueue({
      name: 'code-review',
    }),
  ],
  providers: [GithubService],
  exports: [GithubService],
})
export class GithubModule {}
