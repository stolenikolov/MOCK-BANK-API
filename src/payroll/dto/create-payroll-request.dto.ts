import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PayrollPaymentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  employeeId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  employeeName: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;
}

export class CreatePayrollRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  companyId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => PayrollPaymentDto)
  payments: PayrollPaymentDto[];

  /** The company's linked IBANs. BiznisMk sends all of them. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  accounts: string[];

  /** Payroll currency; only accounts in this currency are used. Defaults to MKD. */
  @IsOptional()
  @IsIn(['MKD', 'EUR'])
  currency?: string;
}
