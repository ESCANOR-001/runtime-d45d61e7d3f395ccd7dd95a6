type JsonRecord = Record<string, unknown>;

export function imageGenerationWaitCell(payload: JsonRecord): string | null {
  if (payload.name !== "wait") return null;
  try {
    const args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
    return typeof args?.cell_id === "string" ? args.cell_id : null;
  } catch { return null; }
}

export function runningImageGenerationCell(output: string): string | null {
  return /Script running with cell ID\s+([A-Za-z0-9_-]+)/u.exec(output)?.[1] ?? null;
}

export function isImageGenerationTool(value: unknown): boolean {
  return typeof value === "string" && /(?:^|__|[./:])(?:imagegen|generate_image|generated_image)$/iu.test(value);
}

export function generatedImagePaths(value: unknown): string[] {
  const paths = new Set<string>();
  const add = (path: unknown) => {
    if (typeof path !== "string" || path.length > 4096) return;
    const candidate = path.trim();
    if (/^(?:\/|[a-z]:[\\/])/iu.test(candidate) && /\.(?:png|jpe?g|webp|gif)$/iu.test(candidate)) paths.add(candidate);
  };
  const visit = (entry: unknown, depth = 0): void => {
    if (depth > 4 || paths.size >= 32) return;
    if (typeof entry === "string") {
      add(entry);
      for (const match of entry.slice(0, 128 * 1024).matchAll(/Generated images are saved to [^\r\n]+? as (.+?) by default\./gu)) add(match[1]);
      return;
    }
    if (Array.isArray(entry)) { entry.slice(0, 128).forEach(child => visit(child, depth + 1)); return; }
    if (!entry || typeof entry !== "object") return;
    const row = entry as JsonRecord;
    for (const key of ["path", "outputPath", "output_path", "savedPath", "saved_path"]) add(row[key]);
    for (const key of ["text", "output", "content", "images", "generatedImages"]) visit(row[key], depth + 1);
  };
  visit(value);
  return [...paths].slice(0, 32);
}
