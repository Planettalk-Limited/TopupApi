import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator'
import { OrderStatus, Provider, ProductType } from '@prisma/client'

export class ListOrdersDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType

  @IsOptional()
  @IsEnum(Provider)
  provider?: Provider

  // Free-text search across paymentIntentId, recipient phone/email, productName.
  @IsOptional()
  @IsString()
  search?: string

  // Inclusive date range on createdAt (ISO-8601).
  @IsOptional()
  @IsISO8601()
  from?: string

  @IsOptional()
  @IsISO8601()
  to?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 25
}
