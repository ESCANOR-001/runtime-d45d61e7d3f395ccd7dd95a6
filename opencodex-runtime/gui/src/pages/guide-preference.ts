export type GuideAudience = "beginner" | "advanced";

export const GUIDE_AUDIENCE_KEY = "ocx-guide-audience";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readGuideAudience(storage: ReadableStorage | undefined = browserStorage()): GuideAudience {
  try {
    return storage?.getItem(GUIDE_AUDIENCE_KEY) === "advanced" ? "advanced" : "beginner";
  } catch {
    return "beginner";
  }
}

export function writeGuideAudience(
  audience: GuideAudience,
  storage: WritableStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(GUIDE_AUDIENCE_KEY, audience);
  } catch {
    // Private browsing or a blocked storage policy must not break the guide.
  }
}
