import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './common/prisma.module';
import { ApiKeyGuard } from './common/api-key.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { LoggingMiddleware } from './common/logging.middleware';
import { AccountsModule } from './accounts/accounts.module';
import { PayrollModule } from './payroll/payroll.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WebhooksModule,
    AccountsModule,
    PayrollModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
