import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma.service';

/** Boots the whole module graph with the database stubbed out, so wiring
 *  mistakes (a missing provider, an unexported service) fail here rather than
 *  on Render. */
describe('AppModule', () => {
  it('resolves every controller and provider', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  });
});
