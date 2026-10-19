import { CanActivate, Injectable, NotFoundException } from '@nestjs/common'

/**
 * Gift Vouchers (Nigeria SureGifts vouchers via buhibab) are off unless
 * GIFT_VOUCHERS_ENABLED=true. Must match the frontend's NEXT_PUBLIC_GIFT_VOUCHERS_ENABLED,
 * which hides the page and its entry points.
 */
export function isVouchersEnabled(): boolean {
  return process.env.GIFT_VOUCHERS_ENABLED === 'true'
}

/** 404s every route on a voucher controller while the feature is off. */
@Injectable()
export class VouchersEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!isVouchersEnabled()) throw new NotFoundException()
    return true
  }
}
