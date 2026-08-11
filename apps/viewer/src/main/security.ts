import path from "node:path";

export function assertArtifactId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("Invalid CircuitInspector artifact identifier");
  }
  return value;
}

export function withArtifactId(input: Record<string, unknown>, field: string): Record<string, unknown> {
  return { ...input, [field]: assertArtifactId(input[field]) };
}

export function assertGrantedPath(grantedPaths: ReadonlySet<string>, value: unknown): string {
  if (typeof value !== "string") throw new Error("Input path must be a string");
  const resolved = path.resolve(value);
  if (!grantedPaths.has(resolved)) throw new Error("Input path was not selected through CircuitInspector");
  return resolved;
}

export function assertPathInside(root: string, value: unknown): string {
  if (typeof value !== "string") throw new Error("Evidence path must be a string");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(value);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Only files inside the CircuitInspector evidence directory can be opened");
  }
  return resolved;
}

export function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}

export function assertRuleDraftUpdate(value: unknown): {
  rule_pack_id: string;
  rules: Array<Record<string, unknown>>;
  review_item_resolutions: Array<{ review_item_id: string; decision: "ACCEPT_SUGGESTION" | "IGNORE" | "MODIFY_RULE"; note: string; rule_id: string | null }>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule draft update");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.rules) || input.rules.some((rule) => !rule || typeof rule !== "object" || Array.isArray(rule))) {
    throw new Error("Invalid rule draft rules");
  }
  if (!Array.isArray(input.review_item_resolutions)) throw new Error("Invalid rule review resolutions");
  const rules = input.rules as Array<Record<string, unknown>>;
  rules.forEach((rule) => assertArtifactId(rule.id));
  const reviewItemResolutions = input.review_item_resolutions.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule review resolution");
    const resolution = value as Record<string, unknown>;
    if (typeof resolution.note !== "string") throw new Error("Invalid rule review resolution note");
    const ruleId = resolution.rule_id === null ? null : assertArtifactId(resolution.rule_id);
    return {
      review_item_id: assertArtifactId(resolution.review_item_id),
      decision: assertOneOf(resolution.decision, ["ACCEPT_SUGGESTION", "IGNORE", "MODIFY_RULE"] as const, "rule review decision"),
      note: resolution.note,
      rule_id: ruleId
    };
  });
  return {
    rule_pack_id: assertArtifactId(input.rule_pack_id),
    rules,
    review_item_resolutions: reviewItemResolutions
  };
}
