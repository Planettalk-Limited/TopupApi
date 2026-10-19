import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { BeneficiariesService } from './beneficiaries.service'
import { CurrentCustomer } from './current-customer.decorator'
import { CustomerAuthGuard } from './customer-auth.guard'
import { AuthenticatedCustomer } from './customer-jwt'
import { CreateBeneficiaryDto } from './dto/customer-auth.dto'

/** Signed-in buyer endpoints (Bearer customer token). */
@Controller('customer')
@UseGuards(CustomerAuthGuard)
export class CustomerController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Get('me')
  me(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return customer
  }

  @Get('beneficiaries')
  listBeneficiaries(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.beneficiaries.list(customer.id)
  }

  @Post('beneficiaries')
  createBeneficiary(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreateBeneficiaryDto) {
    return this.beneficiaries.create(customer.id, dto)
  }

  @Delete('beneficiaries/:id')
  removeBeneficiary(@CurrentCustomer() customer: AuthenticatedCustomer, @Param('id', ParseUUIDPipe) id: string) {
    return this.beneficiaries.remove(customer.id, id)
  }
}
