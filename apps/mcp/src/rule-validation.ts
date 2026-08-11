import type { RuleDocumentValidation } from "@circuit-inspector/workflows";

export function ruleValidationText(rulePackId: string | null, ruleCount: number, validation: RuleDocumentValidation): string {
  const summary = rulePackId
    ? `Created DRAFT rule pack ${rulePackId} with ${ruleCount} candidate rules.`
    : `Rule-source validation failed with ${validation.generation_blocker_count} generation blocker(s); no rule pack was created.`;
  if (validation.diagnostics.length === 0) {
    return `${summary} Human approval in CircuitInspector Viewer is still required.`;
  }
  const details = validation.diagnostics.map((diagnostic) => {
    const location = diagnostic.page !== null
      ? `${diagnostic.source_path}:page ${diagnostic.page}`
      : diagnostic.line !== null
        ? `${diagnostic.source_path}:${diagnostic.line}`
        : diagnostic.paragraph !== null
          ? `${diagnostic.source_path}:paragraph ${diagnostic.paragraph}`
          : diagnostic.source_path;
    const subject = [diagnostic.rule_id, diagnostic.field].filter(Boolean).join("/");
    return `- [${diagnostic.severity}] ${diagnostic.code} at ${location}${subject ? ` (${subject})` : ""}: ${diagnostic.message} Suggested change: ${diagnostic.suggestion}`;
  });
  return [
    summary,
    `Validation ${validation.status}: ${validation.error_count} error(s), ${validation.warning_count} warning(s), ${validation.approval_blocker_count} approval blocker(s).`,
    ...details,
    rulePackId ? "The DRAFT cannot run until it is reviewed and approved in CircuitInspector Viewer." : "Correct the Markdown and call extract_rule_pack again."
  ].join("\n");
}
