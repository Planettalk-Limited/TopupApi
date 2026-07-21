import { Type } from 'class-transformer'
import { IsBooleanString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { Provider } from '@prisma/client'

export class ListProviderLogsDto {
  @IsOptional()
  @IsEnum(Provider)
  provider?: Provider

  // 'true' | 'false' as a query string; only-failures / only-successes filter.
  @IsOptional()
  @IsBooleanString()
  success?: string

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
  pageSize?: number = 50
}

export class ListAuditLogDto {
  @IsOptional()
  @IsString()
  action?: string

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
  pageSize?: number = 50
}
