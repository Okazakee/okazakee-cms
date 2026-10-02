import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./util.mjs', () => ({ run: h.run }));

import { assertLoopbackBindings, ensureLoopbackNetwork } from './network.mjs';

const ok = (value: unknown) => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});
beforeEach(() => h.run.mockReset());

describe('isolated Docker port boundaries', () => {
  it('creates a private bridge with the documented loopback publish default', async () => {
    h.run
      .mockResolvedValueOnce({ code: 1, stderr: 'not found', stdout: '' })
      .mockResolvedValueOnce(ok('network-id'));
    await ensureLoopbackNetwork('/tmp/cms-fixture');
    expect(h.run).toHaveBeenLastCalledWith('docker', [
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
      'cms-loopback-cms-fixture',
    ]);
  });
  it('rejects an existing bridge with public bindings instead of silently reusing it', async () => {
    h.run.mockResolvedValueOnce(
      ok({ 'com.docker.network.bridge.host_binding_ipv4': '0.0.0.0' })
    );
    await expect(ensureLoopbackNetwork('/tmp/cms-fixture')).rejects.toThrow(
      /exclusively to loopback/
    );
    expect(h.run).toHaveBeenCalledTimes(1);
  });
  it('fails closed when no containers are attached to the verified bridge', async () => {
    h.run.mockResolvedValueOnce(ok({}));
    await expect(assertLoopbackBindings('/tmp/cms-fixture')).rejects.toThrow(
      /no containers/
    );
  });
  it('checks effective IPv4/IPv6 loopback publications, allowing internal-only ports', async () => {
    h.run
      .mockResolvedValueOnce(ok({ db: {}, api: {} }))
      .mockResolvedValueOnce(
        ok({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] })
      )
      .mockResolvedValueOnce(
        ok({
          '8000/tcp': [{ HostIp: '::1', HostPort: '54321' }],
          '8001/tcp': null,
        })
      );
    await expect(
      assertLoopbackBindings('/tmp/cms-fixture')
    ).resolves.toBeUndefined();
    expect(h.run).toHaveBeenCalledWith('docker', [
      'inspect',
      'api',
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);
  });
  it.each(['', '0.0.0.0', '::', '192.168.1.10'])(
    'rejects effective non-loopback HostIp "%s"',
    async (HostIp) => {
      h.run
        .mockResolvedValueOnce(ok({ api: {} }))
        .mockResolvedValueOnce(
          ok({ '8000/tcp': [{ HostIp, HostPort: '54321' }] })
        );
      await expect(assertLoopbackBindings('/tmp/cms-fixture')).rejects.toThrow(
        /outside loopback/
      );
    }
  );
});
