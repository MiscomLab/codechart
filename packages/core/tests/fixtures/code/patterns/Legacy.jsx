import React from 'react';

export default function Legacy({ title }) {
  return <section>{title}</section>;
}

export class Panel extends React.Component {
  render() {
    return <div className="panel">{this.props.children}</div>;
  }
}
