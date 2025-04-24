# Pulse

Pulse is a performant library for building scalable, real-time applications with a focus on simplicity, ease of use and security.

It's inspired heavily by Yjs but with some small differences that make a large impact.

## Features

- **Real-Time**: Pulse allows for real-time bidirectional event-driven communication.
- **Scalable**: Pulse is designed to scale horizontally with ease.
- **Simple**: Pulse provides a simple, intuitive API for building real-time applications.

Compared to Yjs, Pulse has the following improvements:

- Objects and documents in Pulse are well-typed and compatible with TypeScript.
- Pulse has direct connections with front-end frameworks like Svelte or Solid to easily handle reactivity.
- Pulse uses a more efficient data structure (resuing client ids) to reduce the amount of data sent over the network.
- Pulse comes with a built-in system for migrations.
- Pulse allows to attach customizable metadata to documents, which can be used to handle permissions, migrations and other use cases.
- Pulse objects consume less storage than Yjs objects.

Pulse also comes with its own cloud database, PulseBase, that is optimized for real-time collaborative applications. With PulseBase, you can get started in minutes and scale to millions of documents.
