import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class ListAccountsQueryDto {
  /** 3-digit bank code, as returned by /accounts/verify. */
  @IsOptional()
  @Matches(/^\d{3}$/)
  bankCode?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'BLOCKED', 'CLOSED'])
  status?: 'ACTIVE' | 'BLOCKED' | 'CLOSED';

  @IsOptional()
  @IsIn(['MKD', 'EUR'])
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  /** `true` returns only accounts not linked to any company. */
  @IsOptional()
  @IsIn(['true', 'false'])
  unclaimed?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
