export type WebhookEventType = 'TRANSACTION_CREATED' | 'PAYROLL_COMPLETED';

export interface WebhookTransaction {
  id: string;
  type: 'CREDIT' | 'DEBIT';
  amount: number;
  currency: string;
  description: string;
  balanceAfter: number;
  createdAt: string;
}

export interface TransactionCreatedEvent {
  eventType: 'TRANSACTION_CREATED';
  iban: string;
  currency: string;
  newBalance: number;
  transactions: WebhookTransaction[];
  timestamp: string;
}

export interface PayrollCompletedEvent {
  eventType: 'PAYROLL_COMPLETED';
  requestId: string;
  companyId: string;
  ibans: string[];
  accounts: Array<{
    iban: string;
    currency: string;
    newBalance: number;
    transactions: WebhookTransaction[];
  }>;
  transactions: WebhookTransaction[];
  timestamp: string;
}

export type WebhookEvent = TransactionCreatedEvent | PayrollCompletedEvent;
