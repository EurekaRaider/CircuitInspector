import type { RulePack } from "./types";

export function selectApprovedRulePack(packs: RulePack[], currentId: string): string {
  const approved = packs.filter((pack) => pack.status === "APPROVED");
  return approved.some((pack) => pack.id === currentId) ? currentId : approved[0]?.id ?? "";
}
