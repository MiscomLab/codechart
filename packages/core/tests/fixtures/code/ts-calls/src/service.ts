export function charge(amount: number): number {
  return amount;
}

export function unused(): void {}

export class PaymentService {
  refund(): void {}

  run(): void {
    charge(1);
    this.refund();
    unknown();
  }
}

export default function settle(): void {
  charge(2);
}
