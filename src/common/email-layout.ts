/**
 * Shared shell for customer-facing email, matching the PlanetTalk Partner Portal's
 * templates (AgentPortalBackend src/templates/email/layouts/base.hbs): banner header,
 * light content panel, dark footer, teal accents. Styles are inline rather than in a
 * <style> block because Gmail and Outlook drop or rewrite head styles.
 *
 * The banner is the portal's header artwork with the "Partner Programme" line removed,
 * served by the storefront from /images/planettalk-email-header.jpg.
 */

export const BRAND_TEAL = '#24B6C3'
const SUPPORT_EMAIL = 'care@planettalk.com'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface LayoutOptions {
  siteUrl: string
  title: string
  /** Inbox preview line (hidden in the body). */
  previewText?: string
  /** Pre-escaped HTML for the content panel. */
  body: string
}

export function renderEmailLayout({ siteUrl, title, previewText, body }: LayoutOptions): string {
  const bannerUrl = `${siteUrl}/images/planettalk-email-header.jpg`
  const year = new Date().getFullYear()
  const preview = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(previewText)}</div>
       <div style="display:none;max-height:0;overflow:hidden;">&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - PlanetTalk</title>
</head>
<body style="margin:0;padding:20px 0;background-color:#e8f6f8;background:linear-gradient(135deg,#e0f7fa 0%,#f0f4f8 100%);font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#333333;">
  ${preview}
  <div style="max-width:650px;margin:0 auto;padding:10px;">
    <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
      <div style="background:#ffffff;text-align:center;">
        <a href="${escapeHtml(siteUrl)}" style="text-decoration:none;">
          <img src="${escapeHtml(bannerUrl)}" alt="PlanetTalk" width="600" style="max-width:100%;height:auto;display:block;margin:0 auto;border:0;" />
        </a>
      </div>
      <div style="padding:30px 24px;background:#f8fafb;font-size:16px;">
        ${body}
      </div>
      <div style="background:#343a40;color:#ffffff;padding:20px;text-align:center;font-size:14px;">
        <p style="margin:5px 0;"><strong>PlanetTalk</strong> - Connecting Families Worldwide</p>
        <p style="margin:5px 0;">This is an automated message. Please do not reply to this email.</p>
        <p style="margin:5px 0;">Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_TEAL};text-decoration:none;">${SUPPORT_EMAIL}</a></p>
        <p style="margin:20px 0 0;font-size:12px;color:${BRAND_TEAL};">&copy; ${year} PlanetTalk. Connecting families worldwide.</p>
      </div>
    </div>
  </div>
</body>
</html>`
}

// ── Content blocks (all return HTML; text arguments are escaped here) ────────────────

export const heading = (text: string) =>
  `<h2 style="color:#333333;margin:0 0 16px;font-size:24px;">${escapeHtml(text)}</h2>`

export const paragraph = (text: string) => `<p style="margin:15px 0;font-size:16px;line-height:1.5;">${escapeHtml(text)}</p>`

export const mutedParagraph = (text: string) =>
  `<p style="margin:15px 0;font-size:14px;line-height:1.5;color:#6c757d;">${escapeHtml(text)}</p>`

/** The one-time code, in the portal's teal block. */
export const codeBlock = (code: string) => `
  <div style="text-align:center;margin:30px 0;">
    <div style="display:inline-block;background-color:${BRAND_TEAL};color:#ffffff;padding:20px 30px;border-radius:8px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace;">${escapeHtml(code)}</div>
  </div>`

export const warningBox = (text: string) => `
  <div style="background-color:#fff3cd;padding:15px;border-radius:6px;margin:20px 0;border-left:3px solid #ffc107;">
    <p style="margin:0;color:#856404;font-weight:bold;">&#9200; ${escapeHtml(text)}</p>
  </div>`

export const button = (href: string, label: string) => `
  <div style="text-align:center;margin:30px 0;">
    <a href="${escapeHtml(href)}" style="display:inline-block;background-color:${BRAND_TEAL};background:linear-gradient(135deg,${BRAND_TEAL} 0%,#00acc1 100%);color:#ffffff;padding:12px 30px;text-decoration:none;border-radius:25px;font-weight:600;box-shadow:0 4px 15px rgba(36,182,195,0.3);">${escapeHtml(label)}</a>
  </div>`

/** A link printed in full for clients that block buttons. */
export const linkBox = (href: string) => `
  <p style="margin:15px 0 8px;font-size:14px;"><strong>Or copy this link into your browser:</strong></p>
  <div style="background-color:#e9ecef;padding:10px;border-radius:4px;font-family:monospace;font-size:12px;word-break:break-all;color:#495057;">${escapeHtml(href)}</div>`

/** Label/value rows in a bordered card, e.g. a receipt. */
export const detailsTable = (rows: Array<[string, string]>) => `
  <div style="background:#ffffff;border:2px solid ${BRAND_TEAL};border-radius:8px;padding:8px 16px;margin:20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows
        .map(
          ([label, value], i) =>
            `<tr><td style="padding:10px 12px 10px 0;color:#6c757d;font-size:14px;${i ? 'border-top:1px solid #eef1f3;' : ''}">${escapeHtml(label)}</td><td style="padding:10px 0;font-weight:600;font-size:15px;text-align:right;word-break:break-all;${i ? 'border-top:1px solid #eef1f3;' : ''}">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}
    </table>
  </div>`
