import React, { Component } from 'react';

type Props = { name: string };

export function Greeting({ name }: Props) {
  return <h1>Hello, {name}</h1>;
}

export const UserList = ({ users }: { users: string[] }) => (
  <ul>
    {users.map((u) => (
      <li key={u}>{u}</li>
    ))}
  </ul>
);

export class Counter extends React.Component<Props, { count: number }> {
  state = { count: 0 };
  render() {
    return <button onClick={() => this.setState({ count: this.state.count + 1 })}>{this.state.count}</button>;
  }
}

export class Clock extends Component<Props> {
  render() {
    return <time />;
  }
}

export function formatName(name: string): string {
  return name.trim();
}

class Store extends EventTarget {}
