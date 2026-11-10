#!/usr/bin/env node
// A tiny MCP server for the tests, over stdio. With --http <port> it speaks streamable HTTP instead.
// Tools: echo, add, fail, slow, pid, big_result.
'use strict';

const http = require('node:http');

const TOOLS = [
  {
    name: 'echo',
    description: 'Gives the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to repeat.' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' }, mode: { enum: ['fast', 'exact'] } }, required: ['a', 'b'] },
  },
  { name: 'fail', description: 'Always reports an error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Waits, then answers.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'pid', description: 'The process id of the server.', inputSchema: { type: 'object', properties: {} } },
];

function handle(message) {
  const { method, params = {} } = message;
  if (method === 'initialize') {
    return { result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') {
    if (!params.cursor) return { result: { tools: TOOLS.slice(0, 2), nextCursor: 'page2' } };
    return { result: { tools: TOOLS.slice(2) } };
  }
  if (method === 'tools/call') {
    const args = params.arguments || {};
    switch (params.name) {
      case 'echo':
        return { result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } };
      case 'add':
        return { result: { content: [{ type: 'text', text: String(args.a + args.b) }] } };
      case 'fail':
        return { result: { isError: true, content: [{ type: 'text', text: 'it failed on purpose' }] } };
      case 'pid':
        return { result: { content: [{ type: 'text', text: String(process.pid) }] } };
      case 'slow':
        return { later: Number(args.ms) || 1000, result: { content: [{ type: 'text', text: 'done' }] } };
      default:
        return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    }
  }
  return { error: { code: -32601, message: 'Method not found' } };
}

function reply(message, out) {
  if (message.id === undefined) return;
  const answer = handle(message);
  const send = () => out({ jsonrpc: '2.0', id: message.id, ...(answer.error ? { error: answer.error } : { result: answer.result }) });
  if (answer.later) setTimeout(send, answer.later);
  else send();
}

const httpPort = process.argv.includes('--http') ? Number(process.argv[process.argv.indexOf('--http') + 1]) : null;

if (httpPort !== null) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, headers: request.headers, body });
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      if (request.headers.authorization !== 'Bearer secret') {
        response.writeHead(401).end('no');
        return;
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      // Alternate the two ways a server may answer: plain JSON, and an event stream.
      const headers = { 'Mcp-Session-Id': 'session-1' };
      const stream = message.method === 'tools/call';
      reply(message, (answer) => {
        if (stream) {
          response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
          response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
          response.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        } else {
          response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
        }
      });
    });
  });
  server.listen(httpPort, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
  process.on('message', () => {});
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
      if (line) reply(JSON.parse(line), (answer) => process.stdout.write(`${JSON.stringify(answer)}\n`));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
