import path from 'node:path';
import { run } from './util.mjs';

export function fixtureNetworkName(workdir) {
  return `cms-loopback-${path.basename(workdir)}`;
}

// Supabase's documented local-development recipe: the bridge's default
// publish address controls HostIP; a loopback API_URL alone does not.
export async function ensureLoopbackNetwork(workdir) {
  const name = fixtureNetworkName(workdir);
  const inspect = await run('docker', [
    'network',
    'inspect',
    name,
    '--format',
    '{{json .Options}}',
  ]);
  if (inspect.code === 0) {
    const options = JSON.parse(inspect.stdout);
    if (
      options['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1'
    ) {
      throw new Error(
        '[isolated] existing fixture network does not bind exclusively to loopback'
      );
    }
    return;
  }
  const created = await run('docker', [
    'network',
    'create',
    '--driver',
    'bridge',
    '--opt',
    'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    name,
  ]);
  if (created.code !== 0)
    throw new Error(
      `[isolated] failed to create loopback network: ${created.stderr}`
    );
}

export async function assertLoopbackBindings(workdir) {
  const containers = await run('docker', [
    'network',
    'inspect',
    fixtureNetworkName(workdir),
    '--format',
    '{{json .Containers}}',
  ]);
  if (containers.code !== 0)
    throw new Error('[isolated] fixture network unavailable');
  const ids = Object.keys(JSON.parse(containers.stdout));
  if (!ids.length)
    throw new Error('[isolated] no containers on the verified fixture network');
  for (const id of ids) {
    const inspected = await run('docker', [
      'inspect',
      id,
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);
    if (inspected.code !== 0)
      throw new Error('[isolated] cannot verify fixture port bindings');
    const ports = JSON.parse(inspected.stdout) || {};
    for (const entries of Object.values(ports)) {
      for (const binding of entries || []) {
        if (!['127.0.0.1', '::1'].includes(binding.HostIp)) {
          throw new Error(
            '[isolated] refusing fixture port published outside loopback'
          );
        }
      }
    }
  }
}
