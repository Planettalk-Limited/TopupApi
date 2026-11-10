// The tiny HTTP client the synthetic checks use. Every call is a plain fetch with a hard
// timeout: a page or endpoint that hangs is as broken to a customer as one that 500s, and
// without the timeout one hung request would also stall every later run.

/** Sent on every probe so these requests are easy to filter out of access logs. */
export const PROBE_USER_AGENT = 'PlanetTalk-SyntheticMonitor/1.0'

export interface Probe {
  getJson(url: string): Promise<unknown>
  postJson(url: string, body: unknown): Promise<unknown>
  /** GET an HTML page. Resolves only on a 2xx HTML response with a non-trivial body. */
  getPage(url: string): Promise<void>
}

export class ProbeError extends Error {}

// A real page from the Next.js app is tens of KB. Anything this small is an error stub
// or an empty proxy response, not the page a customer would see.
const MIN_PAGE_BYTES = 500

export function createProbe(timeoutMs: number): Probe {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response
    try {
      res = await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': PROBE_USER_AGENT, ...(init.headers ?? {}) },
      })
    } catch (err) {
      const e = err as Error
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new ProbeError(`timed out after ${timeoutMs}ms`)
      }
      throw new ProbeError(`request failed: ${e.message}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProbeError(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }
    return res
  }

  async function json(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch {
      throw new ProbeError('response was not valid JSON')
    }
  }

  return {
    async getJson(url) {
      return json(await request(url, { headers: { Accept: 'application/json' } }))
    },
    async postJson(url, body) {
      return json(
        await request(url, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    },
    async getPage(url) {
      const res = await request(url, { headers: { Accept: 'text/html' } })
      const type = res.headers.get('content-type') ?? ''
      if (!type.includes('text/html')) throw new ProbeError(`expected an HTML page, got "${type || 'no content-type'}"`)
      const html = await res.text()
      if (html.length < MIN_PAGE_BYTES) throw new ProbeError(`page body suspiciously small (${html.length} bytes)`)
    },
  }
}
