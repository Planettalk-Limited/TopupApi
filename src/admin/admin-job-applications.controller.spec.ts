import * as http from 'http'
import { PassThrough, Writable } from 'stream'
import { AdminJobApplicationsController, sanitizeFilename } from './admin-job-applications.controller'
import { AdminJobApplicationsService } from './admin-job-applications.service'

describe('sanitizeFilename', () => {
  it('strips quotes and backslashes', () => {
    expect(sanitizeFilename('final "v2".pdf')).toBe('final v2.pdf')
    expect(sanitizeFilename('a\\b.pdf')).toBe('ab.pdf')
  })

  it('replaces non-ASCII characters with underscores', () => {
    expect(sanitizeFilename('简历.pdf')).toBe('__.pdf')
  })

  it('falls back to "cv" when nothing survives sanitization', () => {
    expect(sanitizeFilename('')).toBe('cv')
    expect(sanitizeFilename('""')).toBe('cv')
  })

  it('produces a Content-Disposition value that Node accepts for a hostile filename', () => {
    // Node's header validation rejects code points above \xff — this is the exact
    // failure mode Fix 3 addresses (an unsanitized CJK filename crashing res.setHeader).
    const filename = '简历 "final".pdf'
    const value = `attachment; filename="${sanitizeFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    const res = new http.ServerResponse({} as any)
    expect(() => res.setHeader('Content-Disposition', value)).not.toThrow()
  })
})

describe('AdminJobApplicationsController#downloadCv', () => {
  // A real Writable (not a plain object) so `stream.pipe(res)` works exactly as it
  // does against Express's real Response — .pipe() needs an EventEmitter with
  // write()/end(), which a hand-rolled mock object doesn't provide.
  function makeRes() {
    const headers: Record<string, string> = {}
    const res = new Writable({
      write(_chunk, _enc, callback) {
        callback()
      },
    }) as Writable & { setHeader: jest.Mock; headers: Record<string, string> }
    res.setHeader = jest.fn((name: string, value: string) => {
      headers[name] = value
    })
    res.headers = headers
    jest.spyOn(res, 'destroy')
    // A real HTTP response's error handling is wired up by the underlying socket;
    // our bare test double needs its own listener so destroy(err) doesn't surface
    // as an unhandled 'error' event on the stream.
    res.on('error', () => {})
    return res
  }

  it('attaches an error listener before piping and destroys the response on stream error', async () => {
    const stream = new PassThrough()
    const applications = {
      getCv: jest.fn().mockResolvedValue({
        body: stream,
        contentType: 'application/pdf',
        filename: 'resume.pdf',
      }),
    }
    const controller = new AdminJobApplicationsController(applications as unknown as AdminJobApplicationsService)
    const res = makeRes()

    await controller.downloadCv('app-1', res as any)

    const boom = new Error('boom')
    stream.emit('error', boom)

    expect(res.destroy).toHaveBeenCalledWith(boom)
  })

  it('never crashes on a hostile filename with a quote and non-ASCII characters', async () => {
    const stream = new PassThrough()
    const applications = {
      getCv: jest.fn().mockResolvedValue({
        body: stream,
        contentType: 'application/pdf',
        filename: '简历 "final".pdf',
      }),
    }
    const controller = new AdminJobApplicationsController(applications as unknown as AdminJobApplicationsService)
    const res = makeRes()

    await expect(controller.downloadCv('app-1', res as any)).resolves.toBeUndefined()
    expect(res.headers['Content-Disposition']).toContain('filename="__ final.pdf"')
  })
})
