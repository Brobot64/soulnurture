import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter
  implements ExceptionFilter
{
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(
    exception: unknown,
    host: ArgumentsHost,
  ) {
    const ctx =
      host.switchToHttp();

    const response =
      ctx.getResponse();

    const request =
      ctx.getRequest();

    let status =
      HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] =
      'Internal server error';

    let error =
      'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();

      const exceptionResponse =
        exception.getResponse();

      if (
        typeof exceptionResponse === 'string'
      ) {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const body = exceptionResponse as {
          message?: string | string[];
          error?: string;
        };

        message =
          body.message ?? message;

        error =
          body.error ?? error;
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack ?? exception.message : String(exception),
      );
    }

    response.status(status).send({
      success: false,

      statusCode: status,

      message,

      error,

      path: request.url,

      timestamp: new Date().toISOString(),
    });
  }
}