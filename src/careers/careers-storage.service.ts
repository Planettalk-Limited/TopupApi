import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

export interface UploadCvParams {
  key: string
  body: Buffer
  contentType: string
}

export interface CvStream {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength?: number
}

/**
 * CV binary storage on DigitalOcean Spaces (S3-compatible). Job posting/application
 * metadata lives in Postgres (Prisma) — this service only ever touches file bytes,
 * addressed by a server-generated key, never the uploader's original filename.
 */
@Injectable()
export class CareersStorageService {
  private readonly logger = new Logger(CareersStorageService.name)
  private readonly client: S3Client
  private readonly bucket: string

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('DO_SPACES_BUCKET') ?? ''
    this.client = new S3Client({
      region: this.config.get<string>('DO_SPACES_REGION') ?? 'us-east-1',
      endpoint: this.config.get<string>('DO_SPACES_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('DO_SPACES_KEY') ?? '',
        secretAccessKey: this.config.get<string>('DO_SPACES_SECRET') ?? '',
      },
    })
  }

  generateCvKey(applicationId: string, extension: string): string {
    return `cvs/${applicationId}.${extension}`
  }

  async uploadCv(params: UploadCvParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        ACL: 'private',
      }),
    )
  }

  async getCvStream(key: string): Promise<CvStream> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return {
      body: result.Body as unknown as NodeJS.ReadableStream,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentLength: result.ContentLength,
    }
  }

  async deleteCv(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
