import { CareersStorageService } from './careers-storage.service'

const send = jest.fn()
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3')
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send })),
  }
})

function buildConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    DO_SPACES_KEY: 'key123',
    DO_SPACES_SECRET: 'secret123',
    DO_SPACES_BUCKET: 'planettalk-careers',
    DO_SPACES_REGION: 'fra1',
    DO_SPACES_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
    ...overrides,
  }
  return { get: (k: string) => values[k] }
}

describe('CareersStorageService', () => {
  beforeEach(() => send.mockReset())

  it('generates a key from the application id and extension, never the original filename', () => {
    const service = new CareersStorageService(buildConfig() as any)
    const key = service.generateCvKey('app-123', 'pdf')
    expect(key).toBe('cvs/app-123.pdf')
  })

  it('uploads a CV via PutObjectCommand', async () => {
    send.mockResolvedValue({})
    const service = new CareersStorageService(buildConfig() as any)
    await service.uploadCv({ key: 'cvs/app-123.pdf', body: Buffer.from('pdf-bytes'), contentType: 'application/pdf' })
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command.input).toMatchObject({
      Bucket: 'planettalk-careers',
      Key: 'cvs/app-123.pdf',
      ContentType: 'application/pdf',
    })
  })

  it('deletes a CV via DeleteObjectCommand', async () => {
    send.mockResolvedValue({})
    const service = new CareersStorageService(buildConfig() as any)
    await service.deleteCv('cvs/app-123.pdf')
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command.input).toMatchObject({ Bucket: 'planettalk-careers', Key: 'cvs/app-123.pdf' })
  })
})
