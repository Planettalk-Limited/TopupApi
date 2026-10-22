import { BadRequestException, Controller, Get, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common'
import { VouchersEnabledGuard } from '../../common/vouchers-enabled'
import { PlanetTalkService } from './planettalk.service'
import { VOUCHER_CATEGORIES, VoucherService, type VoucherCategory } from './voucher.service'

/**
 * Gift Vouchers catalog. Nigeria-only, buhibab-only (SureGifts).
 *
 * Flow: GET vouchers -> POST /payments/vouchers/quote -> POST /payments/create-intent
 * with productType "voucher".
 */
@Controller('planettalk/vouchers')
@UseGuards(VouchersEnabledGuard)
export class VoucherCatalogController {
  constructor(
    private readonly vouchers: VoucherService,
    private readonly planettalk: PlanetTalkService,
  ) {}

  /** `?category=groceries` (supermarket vouchers) or `?category=gift` (all others); omit for both. */
  @Get()
  async list(@Query('category') category?: string) {
    if (category && !VOUCHER_CATEGORIES.includes(category as VoucherCategory)) {
      throw new BadRequestException(`category must be one of ${VOUCHER_CATEGORIES.join(', ')}`)
    }
    if (!this.planettalk.hasCredentials()) {
      throw new ServiceUnavailableException('Planet Talk API credentials not configured')
    }
    // fxRate is an input to our pricing, not something the storefront needs.
    return (await this.vouchers.listVouchers(category as VoucherCategory | undefined)).map(
      ({ fxRate: _fxRate, ...v }) => v,
    )
  }
}
