import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyAccountDto {
  @IsString()
  @MinLength(15)
  @MaxLength(34)
  iban: string;

  /**
   * When present, the account is claimed for this company: the first company to
   * verify a free account keeps it. Omit it for a pure lookup.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  companyId?: string;

  /**
   * Who the account goes into the name of - the owner of the claiming company.
   * Required whenever companyId is sent.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  holderName?: string;
}

export class UnlinkAccountDto {
  /** Guard against unlinking someone else's account; optional. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  companyId?: string;
}
