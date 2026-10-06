import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, Observable } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();

    return next.handle().pipe(
      map((data: unknown) => ({
        success: true,
        statusCode: response.statusCode,
        message: 'Request successful',
        data,
        path: request.url,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}