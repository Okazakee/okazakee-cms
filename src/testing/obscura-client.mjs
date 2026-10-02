import { writeFile } from 'node:fs/promises';
import { assertLoopbackUrl } from './lib/env.mjs';

// Connect only to the separately launched, loopback-bound Obscura process.
// Its documented --allow-private-network flag does not alter global settings.
export async function callObscura(name, args = {}, { imagePath } = {}) {
  const endpoint = assertLoopbackUrl(
    'OBSCURA_ENDPOINT',
    process.env.OBSCURA_ENDPOINT || 'http://127.0.0.1:3322/mcp'
  );
  if (['browser_get_cookies', 'browser_storage_state'].includes(name))
    throw new Error('Do not print authentication material');
  if (args.url) {
    assertLoopbackUrl('browser URL', args.url);
    if (!['3100', '3200'].includes(new URL(args.url).port))
      throw new Error('Browser navigation is limited to the isolated fixture');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`Obscura HTTP ${response.status}`);
  const message = await response.json();
  if (message.error) throw new Error(message.error.message);
  if (message.result.isError)
    throw new Error(
      message.result.content.map((item) => item.text || '').join('\n')
    );
  const result = [];
  for (const item of message.result.content || []) {
    if (item.type === 'image') {
      if (!imagePath)
        throw new Error('An output path is required for screenshots');
      await writeFile(imagePath, Buffer.from(item.data, 'base64'));
      result.push(`Screenshot saved: ${imagePath}`);
    } else if (item.type === 'text') result.push(item.text);
  }
  return result.join('\n');
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  try {
    const [name, args = '{}', imagePath] = process.argv.slice(2);
    if (!name)
      throw new Error(
        'Usage: node src/testing/obscura-client.mjs browser_tool [json_args] [image_path]'
      );
    process.stdout.write(
      `${await callObscura(name, JSON.parse(args), { imagePath })}\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
