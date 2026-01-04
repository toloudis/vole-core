import type { AbsolutePath, Array as ZarrArray, AsyncReadable, Chunk, DataType } from "zarrita";
import { FetchStore } from "zarrita";

import VolumeCache, { isChunk } from "../../VolumeCache.js";
import type { WrappedArrayOpts } from "./types.js";
import SubscribableRequestQueue from "../../utils/SubscribableRequestQueue.js";

/**
 * Detects if we're running in an Electron environment
 */
function isElectron(): boolean {
  // Check for both renderer and main process
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    !!process.versions.electron
  );
}

/**
 * Detects if a path is a local file path (not a URL)
 */
function isLocalFilePath(path: string): boolean {
  // Check for common file path patterns
  // Windows: C:\path, \\network\path
  // Unix: /path, ~/path
  // file:// protocol
  return (
    path.startsWith("file://") ||
    path.startsWith("/") ||
    path.startsWith("~/") ||
    /^[a-zA-Z]:\\/.test(path) || // Windows drive letter
    path.startsWith("\\\\")
  );
}

/**
 * Converts file:// URLs to local file paths
 */
function fileUrlToPath(url: string): string {
  if (url.startsWith("file://")) {
    let path = url.slice(7); // Remove 'file://'
    // Handle Windows paths: file:///C:/path -> C:/path
    if (path.startsWith("/") && /^[a-zA-Z]:/.test(path.slice(1))) {
      path = path.slice(1);
    }
    return decodeURIComponent(path);
  }
  return url;
}

type AsyncReadableExt<Opts> = AsyncReadable<Opts & WrappedArrayOpts>;

export default function wrapArray<
  T extends DataType,
  Opts = unknown,
  Store extends AsyncReadable<Opts> = AsyncReadable<Opts>
>(
  array: ZarrArray<T, Store>,
  basePath: string,
  cache?: VolumeCache,
  queue?: SubscribableRequestQueue
): ZarrArray<T, AsyncReadableExt<Opts>> {
  const path = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const keyBase = path + array.path + (array.path.endsWith("/") ? "" : "/");

  const getChunk = async (coords: number[], opts?: Parameters<AsyncReadableExt<Opts>["get"]>[1]): Promise<Chunk<T>> => {
    if (opts?.subscriber && opts.reportChunk) {
      opts.reportChunk(coords, opts.subscriber);
    }

    const fullKey = keyBase + coords.join(",");
    const cacheResult = cache?.get(fullKey);
    if (cacheResult && isChunk(cacheResult)) {
      return cacheResult;
    }

    let result: Chunk<T>;
    if (queue && opts?.subscriber) {
      result = await queue.addRequest(fullKey, opts?.subscriber, () => array.getChunk(coords, opts), opts.isPrefetch);
    } else {
      result = await array.getChunk(coords, opts);
    }

    cache?.insert(fullKey, result);
    return result;
  };

  return new Proxy(array, {
    get: (target, prop) => {
      if (prop === "getChunk") {
        return getChunk;
      }

      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy#no_private_property_forwarding
      const value = target[prop];
      if (value instanceof Function) {
        return function (...args: unknown[]) {
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

export class RelaxedFetchStore extends FetchStore {
  constructor(baseUrl: string, options?: RequestInit) {
    super(baseUrl, options);
  }

  // Solution for https://github.com/manzt/zarrita.js/pull/212
  // taken from https://github.com/vitessce/vitessce/pull/2069
  async get(key: AbsolutePath, options: RequestInit = {}): Promise<Uint8Array | undefined> {
    try {
      return await super.get(key, options);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.message?.startsWith("Unexpected response status 403")) {
        return undefined;
      }
      throw e;
    }
  }
}

/**
 * Creates the appropriate store based on the path and environment.
 * In Electron with local file paths, uses FileSystemStore (dynamically imported).
 * Otherwise, uses RelaxedFetchStore for HTTP(S) URLs.
 */
export async function createStore(path: string, options?: RequestInit): Promise<AsyncReadable<unknown>> {
  // Check if we're in Electron and the path is a local file
  if (isElectron() && isLocalFilePath(path)) {
    const filePath = fileUrlToPath(path);
    try {
      // Dynamically import FileSystemStore only in Node.js/Electron environments
      // Use string concatenation to prevent Vite from trying to resolve at build time
      const moduleName = "@zarrita" + "/storage";
      const { FileSystemStore } = await import(/* @vite-ignore */ moduleName);
      return new FileSystemStore(filePath) as AsyncReadable<unknown>;
    } catch (error) {
      throw new Error(
        `FileSystemStore is not available or failed to initialize: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Default to FetchStore for URLs
  return new RelaxedFetchStore(path, options);
}
