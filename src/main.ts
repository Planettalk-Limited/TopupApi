import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

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
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
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
