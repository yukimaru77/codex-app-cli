import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id == null) continue;
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`);
    continue;
  }
  if (message.method === 'test/error') {
    process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32600, message: 'expected failure' } })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id: message.id, result: { method: message.method, params: message.params } })}\n`);
  process.stdout.write(`${JSON.stringify({ method: 'test/notification', params: { value: 42 } })}\n`);
}
