import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ApiErrorResponseDto,
  ApiSuccessResponseDto,
  AuthHealthDataDto,
  MessageDataDto,
  SessionDto,
  UserDto,
  UserSessionDto,
} from '../common/dto/api-response.dto.js';
import { attachBetterAuthOpenApi } from './better-auth.openapi.js';
import {
  SWAGGER_DESCRIPTION,
  SWAGGER_JSON_PATH,
  SWAGGER_PATH,
  SWAGGER_TAGS,
  SWAGGER_TITLE,
} from './swagger.constants.js';
import { SESSION_COOKIE_NAME } from './openapi.helpers.js';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle(SWAGGER_TITLE)
    .setDescription(SWAGGER_DESCRIPTION)
    .setVersion('0.1.0')
    .setContact('Soul Nurture AI', 'https://soulnurture.ai', 'engineering@soulnurture.ai')
    .addServer('http://localhost:3000', 'Local development')
    .addCookieAuth(SESSION_COOKIE_NAME, {
      type: 'apiKey',
      in: 'cookie',
      name: SESSION_COOKIE_NAME,
      description:
        'Better Auth session cookie. Browser clients should use credentials: "include".',
    })
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Optional bearer token if the client stores the session token outside cookies.',
      },
      'bearer',
    );

  for (const tag of SWAGGER_TAGS) {
    config.addTag(tag.name, tag.description);
  }

  const openApiConfig = config.build();

  const document = SwaggerModule.createDocument(app, openApiConfig, {
    extraModels: [
      ApiSuccessResponseDto,
      ApiErrorResponseDto,
      MessageDataDto,
      AuthHealthDataDto,
      UserDto,
      SessionDto,
      UserSessionDto,
    ],
    operationIdFactory: (controllerKey: string, methodKey: string) =>
      `${controllerKey}_${methodKey}`,
  });

  attachBetterAuthOpenApi(document);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      showRequestDuration: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      tryItOutEnabled: true,
    },
    customSiteTitle: 'Soul Nurture AI · API Docs',
  });
}
