import type {
  Cache,
  CacheStorage,
  ExecutionContext,
  IncomingRequestCfProperties,
} from '@cloudflare/workers-types';
import type { ServerBuild } from '@remix-run/cloudflare';
import { createRequestHandler as createRemixRequestHandler } from '@remix-run/cloudflare';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime';

type VercelRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[]>;
  cookies?: Record<string, string>;
};

type VercelResponse = ServerResponse<IncomingMessage>;

const buildPath = path.join(process.cwd(), 'build/server/index.js');

let cachedBuild: ServerBuild | undefined;
let cachedRemixHandler: ReturnType<typeof createRemixRequestHandler> | undefined;

async function getServerBuild(): Promise<ServerBuild> {
  if (!cachedBuild) {
    cachedBuild = (await import(buildPath)) as unknown as ServerBuild;
  }

  return cachedBuild;
}

async function getRemixHandler() {
  if (!cachedRemixHandler) {
    const build = await getServerBuild();
    cachedRemixHandler = createRemixRequestHandler(build, process.env.NODE_ENV);
  }

  return cachedRemixHandler;
}

function createRequestUrl(req: VercelRequest) {
  const protocol = (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'] || 'https') as string;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost') as string;
  const pathWithQuery = req.url || '/';

  return new URL(pathWithQuery, `${protocol}://${host}`);
}

async function createRemixRequest(req: VercelRequest) {
  const url = createRequestUrl(req);
  const controller = new AbortController();

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const single of value) {
        headers.append(key, single);
      }
    } else {
      headers.set(key, value as string);
    }
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    signal: controller.signal,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    if (body) {
      init.body = body;
    }
  }

  return new Request(url.toString(), init);
}

async function readBody(req: VercelRequest) {
  if (req.body) {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === 'string') {
      return req.body;
    }

    return Buffer.from(JSON.stringify(req.body));
  }

  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      resolve(chunks.length ? Buffer.concat(chunks) : undefined);
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

function createCloudflareEnvProxy() {
  if (typeof process === 'undefined' || !process.env) {
    return {} as Env;
  }

  return new Proxy<Record<string, string | undefined>>(
    {},
    {
      get: (_target, prop: string) => process.env[prop],
      has: (_target, prop: string) => prop in process.env,
    },
  ) as unknown as Env;
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => promise.catch((error) => console.error('waitUntil error', error)),
    passThroughOnException: () => {},
    props: {},
  };
}

const fallbackCache: Cache = {
  async match() {
    return undefined;
  },
  async put() {},
  async delete() {
    return false;
  },
};

const fallbackCaches: CacheStorage = {
  default: fallbackCache,
  async open() {
    return fallbackCache;
  },
};

async function handleStaticAsset(req: VercelRequest, res: VercelResponse, url: URL) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  if (!url.pathname.startsWith('/build/')) {
    return false;
  }

  const filePath = path.join(process.cwd(), 'public', url.pathname);

  try {
    const file = await readFile(filePath);
    const contentType = mime.getType(filePath) || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    res.end(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to read static asset', error);
    }
  }

  return false;
}

async function sendRemixResponse(res: VercelResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};

  response.headers.forEach((value, key) => {
    if (headers[key]) {
      const existing = headers[key];
      headers[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headers[key] = value;
    }
  });

  res.statusCode = response.status;

  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }

  if (response.body) {
    const arrayBuffer = await response.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
    return;
  }

  res.end();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const url = createRequestUrl(req);

    if (await handleStaticAsset(req, res, url)) {
      return;
    }

    const remixRequest = await createRemixRequest(req);
    const remixHandler = await getRemixHandler();

    const response = await remixHandler(remixRequest, {
      cloudflare: {
        env: createCloudflareEnvProxy(),
        ctx: createExecutionContext(),
        caches: ((globalThis as unknown as { caches?: CacheStorage }).caches ?? fallbackCaches) as CacheStorage,
        cf:
          (remixRequest as unknown as { cf?: IncomingRequestCfProperties }).cf ??
          ({} as IncomingRequestCfProperties),
      },
    });

    await sendRemixResponse(res, response);
  } catch (error) {
    console.error('Unhandled error in Vercel handler', error);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
}
