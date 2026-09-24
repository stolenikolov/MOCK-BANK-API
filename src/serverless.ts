import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The bank as one Vercel function (api/index.js). Built once per warm
 * instance and reused; a start that fails is not cached, so the next request
 * tries again. Routes are served at the root, as locally.
 */
let listener: Promise<RequestListener> | null = null;

async function start(): Promise<RequestListener> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestListener;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  listener ??= start().catch((error: unknown) => {
    listener = null;
    throw error;
  });
  const serve = await listener;
  serve(req, res);
}
