export type Currency = 'EUR' | 'USD';

export enum Status {
  Paid,
  Refunded,
}

export interface Receipt {
  amount: number;
  currency: Currency;
}

export class PaymentService {
  charge(amount: number): Receipt {
    return { amount, currency: 'EUR' };
  }

  refund = (receipt: Receipt): Status => (receipt.amount > 0 ? Status.Refunded : Status.Paid);
}

export function format(amount: number): string;
export function format(amount: string): string;
export function format(amount: number | string): string {
  const pad = (s: string) => s.padStart(8);
  return pad(String(amount));
}
