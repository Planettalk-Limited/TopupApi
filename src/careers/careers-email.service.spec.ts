import { CareersEmailService } from './careers-email.service'

const create = jest.fn()
jest.mock('mailgun.js', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      client: () => ({ messages: { create } }),
    })),
  }
})

function buildConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    MAILGUN_API_KEY: 'key',
    MAILGUN_DOMAIN: 'www.planettalk.com',
    MAILGUN_API_URL: 'https://api.eu.mailgun.net',
    CAREERS_FROM_EMAIL: 'PlanetTalk Careers <jointheclan@planettalk.com>',
    CAREERS_NOTIFY_EMAIL: 'jointheclan@planettalk.com',
    ...overrides,
  }
  return { get: (k: string) => values[k] }
}

describe('CareersEmailService', () => {
  beforeEach(() => create.mockReset())

  it('sends an application-received email to the applicant', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    await service.sendApplicationReceived({
      to: 'candidate@example.com',
      jobTitle: 'Backend Engineer',
      applicantFirstName: 'Jamie',
    })
    expect(create).toHaveBeenCalledTimes(1)
    const [domain, message] = create.mock.calls[0]
    expect(domain).toBe('www.planettalk.com')
    expect(message.to).toEqual(['candidate@example.com'])
    expect(message.from).toBe('PlanetTalk Careers <jointheclan@planettalk.com>')
  })

  it('sends a new-application alert to the notify address', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    await service.sendNewApplicationAlert({
      jobTitle: 'Backend Engineer',
      applicantName: 'Jamie Doe',
      applicationId: 'app-1',
    })
    const [, message] = create.mock.calls[0]
    expect(message.to).toEqual(['jointheclan@planettalk.com'])
    expect(message['h:Reply-To']).toBeUndefined()
  })

  it('sendRejection returns true and sends once', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    const sent = await service.sendRejection({
      to: 'candidate@example.com',
      applicantFirstName: 'Jamie',
      jobTitle: 'Backend Engineer',
    })
    expect(sent).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('never throws when Mailgun is not configured — logs and returns false/no-op', async () => {
    const service = new CareersEmailService(buildConfig({ MAILGUN_API_KEY: '' }) as any)
    const sent = await service.sendRejection({
      to: 'candidate@example.com',
      applicantFirstName: 'Jamie',
      jobTitle: 'Backend Engineer',
    })
    expect(sent).toBe(false)
    await expect(
      service.sendApplicationReceived({ to: 'x@example.com', jobTitle: 'X', applicantFirstName: 'X' }),
    ).resolves.toBeUndefined()
  })
})
