import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from 'class-validator';

export class SimulateAmountDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

export class SimulateLoanDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600)
  totalInstallments: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
