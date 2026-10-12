import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { Request, Response } from 'express'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const isHttpException = exception instanceof HttpException
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR

    const message = isHttpException
      ? exception.getResponse()
      : 'Internal server error'

    if (!isHttpException) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      )
    }

    // A machine-readable `code` (e.g. EMAIL_TAKEN, EMAIL_NOT_VERIFIED) survives alongside
    // the human message, so clients can branch without string-matching copy.
    const code =
      message && typeof message === 'object' && typeof (message as any).code === 'string'
        ? ((message as any).code as string)
        : undefined

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      error: typeof message === 'string' ? message : (message as any).message || message,
      ...(code ? { code } : {}),
    })
  }
}
