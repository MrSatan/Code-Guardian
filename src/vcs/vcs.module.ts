import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GithubMiddleware } from './github/github.middleware';
import { GithubModule } from './github/github.module';
import { VcsController } from './vcs.controller';

@Module({
  imports: [ConfigModule, GithubModule],
  controllers: [VcsController],
})
export class VCSModule{};