import { charge, ship } from './barrel';
import settle from './service';
import * as service from './service';
import { helper } from './missing';

export function run(): void {
  charge(1);
  ship();
  settle();
  service.charge(2);
  helper();
  charge.call(null, 3);
}
