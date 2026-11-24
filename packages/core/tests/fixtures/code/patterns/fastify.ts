import Fastify from 'fastify';
import { getUser } from './handlers';

const fastify = Fastify({ logger: true });

fastify.get('/users/:id', getUser);

fastify.route({
  method: 'POST',
  url: '/users',
  handler: async (request, reply) => {
    return reply.code(201).send(request.body);
  },
});

fastify.register(async (instance) => {
  instance.get('/health', async () => ({ ok: true }));
});

await fastify.listen({ port: 3000 });
