import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ApiErrorResponseDto,
  ApiSuccessResponseDto,
} from '../common/dto/api-response.dto.js';

export const SESSION_COOKIE_NAME = 'better-auth.session_token';

export function ApiSessionAuth() {
  return applyDecorators(
    ApiCookieAuth(SESSION_COOKIE_NAME),
    ApiBearerAuth('bearer'),
    ApiUnauthorizedResponse({
      description: 'Missing or invalid session',
      type: ApiErrorResponseDto,
    }),
  );
}

export function ApiEnvelopeOk<T extends Type<unknown>>(
  dataDto: T,
  description = 'Request successful',
) {
  return applyDecorators(
    ApiExtraModels(ApiSuccessResponseDto, dataDto),
    ApiOkResponse({
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiSuccessResponseDto) },
          {
            properties: {
              data: { $ref: getSchemaPath(dataDto) },
            },
          },
        ],
      },
    }),
  );
}

export function ApiEnvelopeOkArray<T extends Type<unknown>>(
  dataDto: T,
  description = 'Request successful',
) {
  return applyDecorators(
    ApiExtraModels(ApiSuccessResponseDto, dataDto),
    ApiOkResponse({
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiSuccessResponseDto) },
          {
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(dataDto) },
              },
            },
          },
        ],
      },
    }),
  );
}

export function ApiStandardErrors() {
  return applyDecorators(
    ApiBadRequestResponse({
      description: 'Validation failed',
      type: ApiErrorResponseDto,
    }),
    ApiForbiddenResponse({
      description: 'Authenticated but not authorized for this resource',
      type: ApiErrorResponseDto,
    }),
    ApiNotFoundResponse({
      description: 'Resource not found',
      type: ApiErrorResponseDto,
    }),
  );
}
