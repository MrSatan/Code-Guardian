import { Injectable, NestMiddleware, RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class GithubMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  use(req: RawBodyRequest<Request>, res: Response, next: NextFunction) {
    console.log(req);
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) {
      return res.status(400).send('Missing signature');
    }

    const secret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      return res.status(500).send('Webhook secret not configured');
    }

    if (!req.rawBody) {
      return res.status(400).send('Missing raw body');
    }

    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(400).send('Invalid signature');
    }

    next();
  }
}
