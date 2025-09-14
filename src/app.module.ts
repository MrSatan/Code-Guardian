import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { PrismaModule } from './database/prisma.module';
import { QueueModule } from './queue/queue.module';
import { VcsModule } from './vcs/vcs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    QueueModule,
    VcsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
