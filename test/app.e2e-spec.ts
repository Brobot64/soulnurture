import { Test, TestingModule } from '@nestjs/testing';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { AppValidationPipe } from '../src/common/pipes/validation.pipe.js';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor.js';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new AppValidationPipe());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/api')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          success: true,
          statusCode: 200,
          message: 'Request successful',
          path: '/api',
        });
        expect(body.data).toBe('Hello World!');
        expect(body.timestamp).toEqual(expect.any(String));
      });
  });

  it('exposes the auth health route', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/health/auth')
      .expect(200);

    expect(response.body.data).toEqual({
      authenticated: true,
      service: 'auth',
    });
  });

  it('protects the current-user and session routes', async () => {
    await request(app.getHttpServer()).get('/api/users/me').expect(401);
    await request(app.getHttpServer()).get('/api/users/session').expect(401);
  });

  it('rejects unauthenticated v1 routes', async () => {
    await request(app.getHttpServer()).get('/api/v1/check-ins').expect(401);
    await request(app.getHttpServer()).get('/api/v1/resources').expect(401);
    await request(app.getHttpServer()).get('/api/v1/conversations').expect(401);
  });

  it('rejects signup for an existing email with 422', async () => {
    const email = `duplicate-${randomUUID()}@example.com`;
    const prisma = app.get(PrismaService);

    await prisma.user.create({
      data: { name: 'Existing Test User', email },
    });

    try {
      const response = await request(app.getHttpServer())
        .post('/api/auth/sign-up/email')
        .set('origin', 'http://localhost:3000')
        .send({
          name: 'Duplicate Test User',
          email,
          password: 'valid-password-123',
        })
        .expect(422);

      expect(response.body).toMatchObject({
        code: 'USER_ALREADY_EXISTS',
        message: 'An account with this email already exists.',
      });
    } finally {
      await prisma.user.delete({ where: { email } });
    }
  });

  it('resends verification using an anonymous email-safe response', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/verification/resend')
      .send({ email: `unknown-${randomUUID()}@example.com` })
      .expect(200);

    expect(response.body.data).toEqual({ status: true });
  });

  afterEach(async () => {
    await app.close();
  });
});
