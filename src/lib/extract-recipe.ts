/**
 * Extracts structured Drink Recipe data from a Makeswift page document's
 * element tree.
 *
 * The document shape (from /v4/pages/{path}/document) nests components inside
 * a root grid element:
 *
 *   data.props.children.value.elements[] → each has { type, key, props }
 *
 * We walk the tree recursively to find every element whose `type` matches
 * the registered component type `custom-drink-recipe`.
 */

import { resolveFile, type MakeswiftFile } from "./makeswift-client";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RecipeProduct {
  entityId: string;
  label: string;
}

export interface RecipeTag {
  id: string;
  label: string;
  value: string;
}

export interface RecipeImage {
  fileId: string;
  publicUrl: string | null;
  name: string | null;
  dimensions: { width: number; height: number } | null;
}

export interface RecipeData {
  name: string;
  image: RecipeImage | null;
  imageAlt: string;
  shortDescription: string;
  description: string;
  ingredients: string[];
  associatedProducts: RecipeProduct[];
  containsTags: RecipeTag[];
  occasionTags: string[];
  recipeTypeTags: string[];
  stepsText: string[];
}

export interface RecipePageEntry {
  pageId: string;
  path: string;
  title: string | null;
  recipe: RecipeData;
}

// ---------------------------------------------------------------------------
// Control value extractors
// ---------------------------------------------------------------------------

/** TextInput / TextArea controls: { "@@makeswift/type": "text-input::v1", "value": "..." } */
function extractTextValue(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    return String((raw as Record<string, unknown>).value ?? "");
  }
  return "";
}

/** List<TextInput> items: [{ id, value: { "@@makeswift/type": "text-input::v1", value: "..." } }] */
function extractTextList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => extractTextValue(item?.value))
    .filter((v) => v.length > 0);
}

/** List<Combobox> items (containsTags): [{ id, value: { id, label, value } }] */
function extractComboboxList(raw: unknown): RecipeTag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item?.value?.label)
    .map((item) => ({
      id: String(item.value.id),
      label: String(item.value.label),
      value: String(item.value.value),
    }));
}

/** List<Group<Combobox>> items (associatedProducts): [{ id, value: { "@@makeswift/type": "group::v1", value: { entityId: { id, label, value } } } }] */
function extractProductList(raw: unknown): RecipeProduct[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => {
      const group = item?.value;
      if (group?.["@@makeswift/type"] === "group::v1") {
        return group.value?.entityId?.value != null;
      }
      return group?.entityId?.value != null;
    })
    .map((item) => {
      const group = item.value;
      const entity =
        group?.["@@makeswift/type"] === "group::v1"
          ? group.value.entityId
          : group.entityId;
      return {
        entityId: String(entity.value),
        label: String(entity.label),
      };
    });
}

/** Extract image reference: { id, type: "makeswift-file", version } */
function extractImageRef(raw: unknown): { fileId: string } | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "makeswift-file" && typeof obj.id === "string") {
    return { fileId: obj.id };
  }
  return null;
}

/** Recursively extract plain text from a Makeswift rich-text (slot) tree */
function extractSlotText(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw !== "object") return [];

  const obj = raw as Record<string, unknown>;

  // Leaf text node
  if ("text" in obj && typeof obj.text === "string") {
    const trimmed = obj.text.trim();
    return trimmed ? [trimmed] : [];
  }

  // Recurse into children / descendants / elements
  const results: string[] = [];
  for (const key of ["children", "descendants", "elements"]) {
    if (Array.isArray(obj[key])) {
      for (const child of obj[key] as unknown[]) {
        results.push(...extractSlotText(child));
      }
    }
  }

  // Also recurse into props.text (Text component)
  if (obj.props && typeof obj.props === "object") {
    const props = obj.props as Record<string, unknown>;
    if (props.text) {
      results.push(...extractSlotText(props.text));
    }
    // And into slot children (grid columns)
    if (props.children) {
      results.push(...extractSlotText(props.children));
    }
  }

  // Grid value wrapper
  if (obj.value && typeof obj.value === "object") {
    results.push(...extractSlotText(obj.value));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main extractor — walks the element tree
// ---------------------------------------------------------------------------

const DRINK_RECIPE_TYPE = "custom-drink-recipe";

interface ElementNode {
  type: string;
  key: string;
  props: Record<string, unknown>;
}

/** Recursively find all elements matching the drink recipe type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRecipeElements(node: any): ElementNode[] {
  const found: ElementNode[] = [];
  if (!node || typeof node !== "object") return found;

  if (node.type === DRINK_RECIPE_TYPE && node.props) {
    found.push(node as ElementNode);
  }

  // Recurse into grid children
  const children = node.props?.children;
  if (children?.value?.elements && Array.isArray(children.value.elements)) {
    for (const el of children.value.elements) {
      found.push(...findRecipeElements(el));
    }
  }

  // Recurse into slot elements
  if (node.elements && Array.isArray(node.elements)) {
    for (const el of node.elements) {
      found.push(...findRecipeElements(el));
    }
  }

  return found;
}

/** Extract a clean RecipeData from a single drink-recipe element's props */
async function extractRecipeFromProps(
  props: Record<string, unknown>
): Promise<RecipeData> {
  // Image resolution
  let image: RecipeImage | null = null;
  const imgRef = extractImageRef(props.imageSrc);
  if (imgRef) {
    let file: MakeswiftFile | null = null;
    try {
      file = await resolveFile(imgRef.fileId);
    } catch {
      // graceful fallback
    }
    image = {
      fileId: imgRef.fileId,
      publicUrl: file?.publicUrl ?? null,
      name: file?.name ?? null,
      dimensions: file?.dimensions ?? null,
    };
  }

  return {
    name: extractTextValue(props.name),
    image,
    imageAlt: extractTextValue(props.imageAlt),
    shortDescription: extractTextValue(props.shortDescription),
    description: extractTextValue(props.description),
    ingredients: extractTextList(props.ingredients),
    associatedProducts: extractProductList(props.associatedProducts),
    containsTags: extractComboboxList(props.containsTags),
    occasionTags: extractTextList(props.occasionTags),
    recipeTypeTags: extractTextList(props.recipeTypeTags),
    stepsText: extractSlotText(props.steps),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Given a raw Makeswift page document (from /v4/pages/{path}/document),
 * extract all drink-recipe components and return structured RecipeData[].
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractRecipesFromDocument(doc: any): Promise<RecipeData[]> {
  const elements = findRecipeElements(doc.data);
  return Promise.all(elements.map((el) => extractRecipeFromProps(el.props)));
}
