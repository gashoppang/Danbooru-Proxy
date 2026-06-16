import { strict as assert } from 'node:assert';
import { Server } from 'node:http';
import test from 'node:test';
import { createDanbooruEgressServer } from './server';

function createConfig() {
  return {
    host: '127.0.0.1',
    port: 0,
    origin: 'https://danbooru.donmai.us',
    token: 'test-token',
    upstreamTimeoutMs: 1000,
    maxPathLength: 4096,
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
    userAgent: 'danbooru-proxy-test/1.0',
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unexpected server address');
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('health endpoint does not call upstream', async () => {
  let calls = 0;
  const server = createDanbooruEgressServer(createConfig(), {
    fetchImpl: (async () => {
      calls += 1;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok', service: 'danbooru-egress' });
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test('authorized request forwards allowed Danbooru path', async () => {
  const upstreamUrls: string[] = [];
  const server = createDanbooruEgressServer(createConfig(), {
    fetchImpl: (async (input) => {
      upstreamUrls.push(String(input));
      return new Response(JSON.stringify([{ name: 'cat_ears' }]), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }) as typeof fetch,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/v1/danbooru/fetch?path=${encodeURIComponent(
        '/tags.json?search[name_matches]=cat*&limit=5',
      )}`,
      { headers: { authorization: 'Bearer test-token' } },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, [{ name: 'cat_ears' }]);
    assert.deepEqual(upstreamUrls, [
      'https://danbooru.donmai.us/tags.json?search[name_matches]=cat*&limit=5',
    ]);
  } finally {
    await close(server);
  }
});

test('unauthorized request is rejected before upstream fetch', async () => {
  let calls = 0;
  const server = createDanbooruEgressServer(createConfig(), {
    fetchImpl: (async () => {
      calls += 1;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/v1/danbooru/fetch?path=${encodeURIComponent('/tags.json?limit=1')}`,
    );
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'unauthorized' });
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test('disallowed Danbooru path is rejected', async () => {
  let calls = 0;
  const server = createDanbooruEgressServer(createConfig(), {
    fetchImpl: (async () => {
      calls += 1;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/v1/danbooru/fetch?path=${encodeURIComponent('/users.json?limit=1')}`,
      { headers: { authorization: 'Bearer test-token' } },
    );
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: 'target_path_not_allowed' });
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test('HTML challenge is converted to upstream error', async () => {
  const server = createDanbooruEgressServer(createConfig(), {
    fetchImpl: (async () =>
      new Response('<html><title>Just a moment...</title></html>', {
        status: 403,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      })) as typeof fetch,
  });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/v1/danbooru/fetch?path=${encodeURIComponent('/tags.json?limit=1')}`,
      { headers: { authorization: 'Bearer test-token' } },
    );
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error, 'upstream_non_json_response');
    assert.equal(body.upstreamStatus, 403);
  } finally {
    await close(server);
  }
});
