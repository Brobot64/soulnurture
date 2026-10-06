import { Injectable, ValidationPipe as NestValidationPipe } from '@nestjs/common';

@Injectable()
export class AppValidationPipe
  extends NestValidationPipe
{
  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    });
  }
}