import { INestApplication, ValidationPipe } from '@nestjs/common';

/** What the app needs beyond its modules, shared by main.ts and the Vercel entry. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
}
