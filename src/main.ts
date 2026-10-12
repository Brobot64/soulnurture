import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { AppValidationPipe } from './common/pipes/validation.pipe.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { setupSwagger } from './docs/setup-swagger.js';
import { SWAGGER_PATH } from './docs/swagger.constants.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      bodyParser: false,
    },
  );

  const cors = (await import('@fastify/cors')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const multipart = (await import('@fastify/multipart')).default;
  const origins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // @fastify/cors defaults allow-methods to GET,HEAD,POST only — without an
  // explicit list the browser blocks PATCH/PUT/DELETE preflights cross-origin.
  await app.register(cors, {
    origin: origins.length ? origins : true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie, { secret: process.env.BETTER_AUTH_SECRET });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(new AppValidationPipe());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
  const url = await app.getUrl();
  console.log(`Server is running at ${url}`);
  console.log(`Swagger docs at ${url}/${SWAGGER_PATH}`);
}
await bootstrap();
