import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Injectable } from '@nestjs/common';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}

@Entity({ name: 'orders' })
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User)
  user: User;
}

@Injectable()
export class UserService {}

export class Plain {}

@Entity('audit_log')
class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;
}
