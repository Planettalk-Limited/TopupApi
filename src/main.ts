import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  // rawBody: true populates `req.rawBody: Buffer` on every request (used by the
  // Stripe webhook to verify signatures) while Nest still runs normal JSON body
  // parsing for all other routes.
  const app = await NestFactory.create(AppModule, { rawBody: true })

  // CORS_ORIGIN is a comma-separated allowlist, e.g.
  //   CORS_ORIGIN=https://mobiletopup.planettalk.com
  // Empty/unset reflects no origin (safer default than allow-all for a
  // brand-new service — set it explicitly per environment).
  const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // Authorization is required for the admin panel's Bearer JWT requests.
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  const port = process.env.PORT || 3000
  await app.listen(port)
  console.log(`topup-api listening on :${port}/api`)
}

bootstrap()
