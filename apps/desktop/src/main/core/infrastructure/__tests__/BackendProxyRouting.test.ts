import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { protocol, session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendProxyProtocolManager } from '../BackendProxyProtocolManager';
import { RendererProtocolManager, StaticRendererFallback } from '../RendererProtocolManager';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
  protocol: { handle: vi.fn() },
  session: { defaultSession: {} },
}));

vi.mock('@/utils/platform', () => ({
  dev: () => false,
  linux: () => false,
  macOS: () => true,
  windows: () => false,
}));

describe('app:// backend routing before static SPA fallback', () => {
  let rendererDir: string;
  let backend: BackendProxyProtocolManager;
  let handle: (request: Request) => Promise<Response>;
  const upstream = vi.fn<typeof fetch>();
  const html = '<!doctype html><title>LobeHub</title>';

  beforeEach(async () => {
    vi.clearAllMocks();
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
    rendererDir = await mkdtemp(path.join(os.tmpdir(), 'lobehub-proxy-routing-'));
    const entry = path.join(rendererDir, 'index.html');
    await writeFile(entry, html);

    backend = new BackendProxyProtocolManager();
    const renderer = new RendererProtocolManager({
      // An extensionless path resolves directly to the SPA entry in production.
      fallback: new StaticRendererFallback(rendererDir, async () => entry),
    });
    renderer.addRequestInterceptor(backend.createAppRequestInterceptor());
    renderer.registerHandler();
    handle = vi.mocked(protocol.handle).mock.calls[0]![1] as typeof handle;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(rendererDir, { force: true, recursive: true });
  });

  const registerBackend = (remoteBaseUrl: string | null = 'https://remote.example.com') => {
    backend.registerWithRemoteBaseUrl(session.defaultSession, {
      getAccessToken: async () => 'test-oidc-token',
      getRemoteBaseUrl: async () => remoteBaseUrl,
    });
  };

  it.each(['/api/asr/realtime/session', '/api/future-feature/action'])(
    'forwards %s with its body, query and authentication instead of returning HTML',
    async (pathname) => {
      registerBackend();
      upstream.mockImplementationOnce(async (input, init) => {
        const request = new Request(input, init);
        return Response.json({
          authenticated: request.headers.get('Oidc-Auth') === 'test-oidc-token',
          body: await request.json(),
          contentType: request.headers.get('Content-Type'),
          method: request.method,
          url: request.url,
          workspaceId: request.headers.get('X-Workspace-Id'),
        });
      });

      const response = await handle(
        new Request(`app://renderer${pathname}?source=dictation`, {
          body: JSON.stringify({ platform: 'web' }),
          headers: {
            'Content-Type': 'application/json',
            'X-Workspace-Id': 'workspace-test',
          },
          method: 'POST',
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({
        authenticated: true,
        body: { platform: 'web' },
        contentType: 'application/json',
        method: 'POST',
        url: `https://remote.example.com${pathname}?source=dictation`,
        workspaceId: 'workspace-test',
      });
    },
  );

  it.each(['missing context', 'missing remote', 'network failure'])(
    'returns an error rather than the SPA entry on %s',
    async (failure) => {
      if (failure === 'missing remote') registerBackend(null);
      if (failure === 'network failure') {
        registerBackend();
        upstream.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
      }

      const response = await handle(
        new Request('app://renderer/api/asr/realtime/session', { method: 'POST' }),
      );

      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(html);
    },
  );

  it('preserves an upstream authentication error', async () => {
    registerBackend();
    upstream.mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }));

    const response = await handle(
      new Request('app://renderer/api/asr/realtime/session', { method: 'POST' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it.each(['/agent/test', '/apix', '/apiary', '/api-auth'])(
    'keeps the page route %s out of the backend proxy',
    async (pathname) => {
      registerBackend();

      const response = await handle(new Request(`app://renderer${pathname}`));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(html);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});
