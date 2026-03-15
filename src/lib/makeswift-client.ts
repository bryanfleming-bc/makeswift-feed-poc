/**
 * Lightweight Makeswift API client that mirrors the internal SDK endpoints
 * without requiring the full @makeswift/runtime dependency.
 *
 * Endpoints used:
 *   GET  /v5/pages           — list pages (supports pathPrefix filter)
 *   GET  /v4/pages/{path}/document — fetch full element tree for a page
 *   POST /graphql            — resolve file IDs to public URLs
 */

const API_ORIGIN = process.env.MAKESWIFT_API_ORIGIN ?? "https://api.makeswift.com";
const API_KEY = process.env.MAKESWIFT_SITE_API_KEY!;

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function msFetch(path: string): Promise<Response> {
  const url = new URL(path, API_ORIGIN);
  return fetch(url.toString(), {
    headers: {
      "X-API-Key": API_KEY,
      "Makeswift-Site-API-Key": API_KEY,
    },
    cache: "no-store",
  });
}

// ---------------------------------------------------------------------------
// Page types
// ---------------------------------------------------------------------------

export interface MakeswiftPageMeta {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  isOnline: boolean | null;
  locale: string;
}

interface ListPagesResponse {
  data: MakeswiftPageMeta[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// List pages with automatic pagination
// ---------------------------------------------------------------------------

export async function listPages(pathPrefix: string): Promise<MakeswiftPageMeta[]> {
  const all: MakeswiftPageMeta[] = [];
  let after: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({
      pathPrefix,
      limit: "100",
      sortBy: "path",
      sortDirection: "asc",
    });
    if (after) params.set("after", after);

    const res = await msFetch(`v5/pages?${params}`);
    if (!res.ok) {
      throw new Error(`listPages failed: ${res.status} ${res.statusText}`);
    }

    const body: ListPagesResponse = await res.json();
    all.push(...body.data);

    if (!body.hasMore || body.data.length === 0) break;
    after = body.data[body.data.length - 1]!.id;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Get page document (element tree)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPageDocument(pathname: string): Promise<any | null> {
  const res = await msFetch(`v4/pages/${encodeURIComponent(pathname)}/document`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`getPageDocument failed for ${pathname}: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Resolve Makeswift file IDs to public URLs via GraphQL
// ---------------------------------------------------------------------------

export interface MakeswiftFile {
  id: string;
  name: string;
  publicUrl: string;
  extension: string;
  dimensions: { width: number; height: number } | null;
}

export async function resolveFile(fileId: string): Promise<MakeswiftFile | null> {
  const query = `
    query File($fileId: ID!) {
      file(id: $fileId) {
        __typename id name
        publicUrl: publicUrlV2
        extension
        dimensions { width height }
      }
    }
  `;

  const res = await fetch(new URL("graphql", API_ORIGIN).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { fileId } }),
    cache: "no-store",
  });

  if (!res.ok) return null;

  const body = await res.json();
  return body?.data?.file ?? null;
}

// ---------------------------------------------------------------------------
// Batch-resolve multiple file IDs
// ---------------------------------------------------------------------------

export async function resolveFiles(
  fileIds: string[]
): Promise<Map<string, MakeswiftFile>> {
  const map = new Map<string, MakeswiftFile>();
  // Resolve in parallel, bounded to avoid hammering
  const results = await Promise.allSettled(fileIds.map((id) => resolveFile(id)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      map.set(fileIds[i]!, r.value);
    }
  });
  return map;
}
