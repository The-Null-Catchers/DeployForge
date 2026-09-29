import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';

export const notFound = (what = 'Resource') => new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'not_found', message: `${what} not found` });
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'forbidden', message });
export const conflict = (message: string, code = 'conflict') => new ConflictException({ statusCode: 409, error: 'Conflict', code, message });

/** Uniform JSON errors. Internal errors never leak stack traces or SQL. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(
        typeof body === 'string' ? { statusCode: status, error: exception.name, message: body } : { statusCode: status, ...(body as object) },
      );
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(409).json({ statusCode: 409, error: 'Conflict', code: 'already_exists', message: 'A resource with these values already exists' });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(404).json({ statusCode: 404, error: 'Not Found', code: 'not_found', message: 'Resource not found' });
        return;
      }
    }
    this.logger.error({ err: exception, path: req.path }, 'Unhandled error');
    res.status(500).json({ statusCode: 500, error: 'Internal Server Error', message: 'An unexpected error occurred' });
  }
}
