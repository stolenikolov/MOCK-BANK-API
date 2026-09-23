import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { CreatePayrollRequestDto } from './dto/create-payroll-request.dto';

@Controller('payroll/requests')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePayrollRequestDto) {
    return this.payroll.createRequest(dto);
  }

  @Get(':requestId')
  get(@Param('requestId') requestId: string) {
    return this.payroll.getRequest(requestId);
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('requestId') requestId: string) {
    return this.payroll.approve(requestId);
  }

  @Post(':requestId/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Param('requestId') requestId: string) {
    return this.payroll.reject(requestId);
  }
}
