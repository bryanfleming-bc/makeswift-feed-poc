import { NextResponse } from "next/server";

import { listPages, getPageDocument } from "@/lib/makeswift-client";
import {
  extractRecipesFromDocument,
  type RecipePageEntry,
} from "@/lib/extract-recipe";

export const dynamic = "force-dynamic";

/**
 * GET /api/recipes
 *
 * Returns a JSON feed of all Makeswift pages whose path begins with the
 * configured RECIPE_PATH_PREFIX (default "/recipe"). For each page the
 * response includes the full structured drink-recipe component data.
 *
 * Query params:
 *   ?prefix=/recipe   — override the path prefix filter
 *   ?pretty=1         — pretty-print the JSON response
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get("prefix") ?? process.env.RECIPE_PATH_PREFIX ?? "/recipe";
    const pretty = searchParams.has("pretty");

    // 1. List all pages matching the prefix
    const pages = await listPages(prefix);

    // 2. For each page, fetch the document and extract recipes
    const entries: RecipePageEntry[] = [];

    const results = await Promise.allSettled(
      pages.map(async (page) => {
        const doc = await getPageDocument(page.path);
        if (!doc) return null;

        const recipes = await extractRecipesFromDocument(doc);
        if (recipes.length === 0) return null;

        // A page typically has one drink recipe, but we support multiple
        return recipes.map(
          (recipe): RecipePageEntry => ({
            pageId: page.id,
            path: page.path,
            title: page.title,
            recipe,
          })
        );
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        entries.push(...result.value);
      }
    }

    const body = {
      count: entries.length,
      prefix,
      generatedAt: new Date().toISOString(),
      recipes: entries,
    };

    return new NextResponse(
      JSON.stringify(body, null, pretty ? 2 : undefined),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    console.error("Recipe feed error:", err);
    return NextResponse.json(
      { error: "Failed to generate recipe feed", detail: String(err) },
      { status: 500 }
    );
  }
}
