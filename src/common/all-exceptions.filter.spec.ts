import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { AllExceptionsFilter } from './all-exceptions.filter'

function run(exception: unknown) {
  const json = jest.fn((_body: any) => undefined)
  const status = jest.fn((_code: number) => ({ json }))
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/api/x' }),
    }),
  }
  new AllExceptionsFilter().catch(exception, host as any)
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] }
}

describe('AllExceptionsFilter', () => {
  it('reduces a plain HttpException to its message', () => {
    const { status, body } = run(new BadRequestException('nope'))
    expect(status).toBe(400)
    expect(body.error).toBe('nope')
    expect(body).not.toHaveProperty('code')
  })

  it('passes a machine-readable `code` through so clients can branch on it', () => {
    const { status, body } = run(new ConflictException({ code: 'EMAIL_TAKEN', message: 'Email already registered' }))
    expect(status).toBe(409)
    expect(body.error).toBe('Email already registered')
    expect(body.code).toBe('EMAIL_TAKEN')
  })

  it('ignores a non-string code', () => {
    const { body } = run(new ForbiddenException({ code: 42, message: 'x' }))
    expect(body).not.toHaveProperty('code')
  })
})
