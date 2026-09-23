import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { UnlinkAccountDto, VerifyAccountDto } from './dto/verify-account.dto';
import { SimulateAmountDto, SimulateLoanDto } from './dto/simulate.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions.dto';
import { ListAccountsQueryDto } from './dto/list-accounts.dto';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyAccountDto) {
    return this.accounts.verify(dto.iban, dto.companyId, dto.holderName);
  }

  @Post(':iban/unlink')
  @HttpCode(HttpStatus.OK)
  unlink(@Param('iban') iban: string, @Body() dto: UnlinkAccountDto) {
    return this.accounts.unlink(iban, dto.companyId);
  }

  @Get()
  list(@Query() query: ListAccountsQueryDto) {
    return this.accounts.list(query);
  }

  @Get(':iban')
  getState(@Param('iban') iban: string) {
    return this.accounts.getState(iban);
  }

  @Get(':iban/transactions')
  listTransactions(@Param('iban') iban: string, @Query() query: ListTransactionsQueryDto) {
    return this.accounts.listTransactions(iban, query.limit ?? 50, query.cursor);
  }

  @Post(':iban/simulate/deposit')
  @HttpCode(HttpStatus.CREATED)
  deposit(@Param('iban') iban: string, @Body() dto: SimulateAmountDto) {
    return this.accounts.deposit(iban, dto);
  }

  @Post(':iban/simulate/withdraw')
  @HttpCode(HttpStatus.CREATED)
  withdraw(@Param('iban') iban: string, @Body() dto: SimulateAmountDto) {
    return this.accounts.withdraw(iban, dto);
  }

  @Post(':iban/simulate/loan')
  @HttpCode(HttpStatus.CREATED)
  loan(@Param('iban') iban: string, @Body() dto: SimulateLoanDto) {
    return this.accounts.loan(iban, dto);
  }
}
