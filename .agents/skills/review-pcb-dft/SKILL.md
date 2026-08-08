---
name: review-pcb-dft
description: Review PCB and PCBA design-for-test readiness for manufacturing test across bare-board electrical test, ICT, flying probe, boundary scan or JTAG, programming, and functional test. Use when Codex must assess ODB++, Gerber, IPC-356, IPC-2581, schematics, BOMs, BSDL files, production-test requirements, fixture constraints, or factory DFT rules; separate deterministic CircuitInspector geometry checks from document-backed review and factory confirmation, and never invent universal numeric thresholds.
---

# Review PCB DFT

Assess whether a board is ready for manufacturing test. Combine deterministic CircuitInspector results with document review and explicit factory-confirmation gaps. Follow the user's language; default to Chinese when the user writes in Chinese.

## Apply the evidence contract

- Use only `PASS`, `FAIL`, `REVIEW`, and `NOT_APPLICABLE` as finding and overall statuses.
- Tag every finding with exactly one verification mode:
  - `AUTOMATED_GEOMETRY`: measured by CircuitInspector from supported manufacturing data and an approved rule pack.
  - `DOCUMENT_BACKED`: supported by a supplied, applicable schematic, BOM, BSDL, test specification, or other controlled document.
  - `MANUAL_FACTORY_CONFIRMATION`: dependent on tester, probe, fixture, line, operator, or process capability that has not been demonstrated.
- Never promote inferred, conflicted, stale, or missing evidence to `PASS` or `FAIL`.
- Preserve source paths, document revisions or hashes, rule citations, design IDs, analysis IDs, and evidence URIs when available.
- Report a clean result with the same evidence and missing-input sections used for a failing result.

## Load the references

- Read [industry-practices.md](references/industry-practices.md) for every full PCBA review, test-strategy decision, or manual checklist assessment.
- Read [circuitinspector-workflow.md](references/circuitinspector-workflow.md) before invoking CircuitInspector or interpreting its coverage, diagnostics, rule packs, verdicts, and reports.
- Do not copy complete standards into outputs. Cite the applicable standard or public guidance and summarize only what is needed for the decision.

## 1. Establish scope and inventory inputs

Identify the product stage, expected volume, board variants, panel form, allowed test sides, target tester or factory, expected test time, fault-localization need, and required traceability. If a missing choice materially changes the test strategy, ask for it; otherwise record a conservative assumption as `REVIEW`.

Inventory these inputs without claiming that presence proves correctness:

- Manufacturing data: ODB++, Gerber/Excellon, Gerber Job, IPC-356, IPC-2581, centroid/placement, panel and stack-up data.
- Design intent: schematic, BOM/AVL, netlist, assembly drawing, test-point attributes, power tree, interface definitions, and variant rules.
- Test assets: factory or tester DFT specification, fixture constraints, test limits, BSDL files, programming images and scripts, functional-test specification, calibration requirements, and golden-unit data.
- Governance: document revision, product revision, approver, effective factory or line, and change-control state.

Create an input-readiness table with `present`, `revision`, `used_for`, `evidence`, and `gap` fields. Treat mismatched product revisions as a conflict, not as usable corroboration.

## 2. Select a combined manufacturing-test strategy

Map each selected method to the defects it is expected to detect. Do not treat one method or one coverage percentage as proof of complete manufacturing coverage.

Consider, at minimum:

- Bare-board electrical test for pre-assembly opens and shorts.
- Flying probe for prototypes, low volume, changing layouts, or cases where fixture cost dominates.
- ICT for repeatable structural and component-level coverage where volume and physical access justify a fixture.
- Boundary scan or JTAG for limited-access digital interconnects, compatible devices, programming, and debug.
- Programming and secure provisioning for blank-device detection, firmware identity, serialization, verification, and controlled locking.
- FCT for powered behavior, external interfaces, sensors, actuators, calibration, safety, and end-to-end product functions.

Record each method as `SELECTED`, `SUPPLEMENTAL`, or `NOT_SELECTED`, with its target fault classes, prerequisites, residual gaps, and reason. Base the selection on product evidence, not a generic rule such as "ICT for every board."

## 3. Resolve rule authority before numeric checks

Apply this precedence from highest to lowest:

1. Approved project, factory, tester, or fixture requirement that matches the exact product revision and line.
2. A formal standard requirement whose revision and applicability are established.
3. Public equipment-vendor or industry guidance whose assumptions match the use case.
4. An engineering heuristic or experience baseline.

Use tier 4 only to raise `REVIEW`. Use tier 3 as binding only when the user or factory confirms applicability; otherwise use it to raise `REVIEW`. Do not invent pad diameters, probe pitch, edge clearance, component-height keep-outs, target coverage percentages, test limits, or measurement tolerances.

When rules conflict, list the competing sources and values, identify the affected checks, set them to `REVIEW`, and name the role that must resolve the conflict. Never average or silently choose between them.

## 4. Run deterministic CircuitInspector checks

Use the tool sequence and limitations in [circuitinspector-workflow.md](references/circuitinspector-workflow.md).

1. Import supported manufacturing data and inspect semantic coverage plus diagnostics.
2. List rule packs. Select only an `APPROVED` pack that matches the project, factory, tester, and revision.
3. If the user supplies a local rule document and requests extraction, create a `DRAFT` with `extract_rule_pack`. Do not approve it, edit it into an approved state, or run it. Direct the user to review and approve it in CircuitInspector Viewer.
4. Analyze the design with the selected approved rule pack.
5. Page through relevant violations instead of relying only on aggregate counts.
6. Render evidence for every high-severity finding and representative lower-severity groups. Preserve the HTML report link even when no violations exist.

If the tools are unavailable, state `AUTOMATED_GEOMETRY: NOT_RUN` and continue the document and factory review. Do not simulate tool output or manufacture measurements.

## 5. Perform document-backed and factory reviews

Review the following lanes using [industry-practices.md](references/industry-practices.md):

- Probe and fixture access: target geometry, mask opening, side access, probe approach, component/edge/keep-out clearance, support, clamps, tooling, and panel effects.
- Electrical controllability and observability: power, ground, sequencing, current limiting, discharge, reset, clocks, boot straps, isolation, bus contention, back-powering, and measurement references.
- Boundary scan: device support, exact BSDL/package mapping, chain topology, TAP access, reset, pulls, voltage domains, signal integrity, debug isolation, and manufacturing coverage.
- Programming and provisioning: access, power state, image identity, read-back, unique identity, secrets, retries, lock timing, recovery, and audit logs.
- FCT: safe connection, loads and loopbacks, stimuli and observations, calibration, limits and uncertainty, state cleanup, throughput, logging, and reproducibility.

Distinguish a design provision from a validated production process. For example, an accessible JTAG header is not proof that a valid BSDL, executable chain test, programming algorithm, and factory fixture exist.

## 6. Adjudicate without false confidence

Set the overall status using this order:

1. `FAIL` when at least one applicable authoritative requirement has a supported failure.
2. `REVIEW` when there is no supported failure but any required lane contains missing evidence, inferred semantics, a data conflict, an unapproved rule, a heuristic concern, or an unvalidated factory dependency.
3. `PASS` only when every required lane has adequate evidence, all applicable authoritative checks pass, and no unresolved review item remains.
4. `NOT_APPLICABLE` only when the requested lane genuinely does not apply; do not use it as a substitute for missing data.

Do not calculate an overall score by averaging unrelated checks. If coverage percentages are supplied, state their denominator, fault model, exclusions, method, and source; otherwise report coverage by fault class and evidence lane.

## 7. Produce the review report

Use this fixed structure:

1. **结论与范围** — overall status, product revision, selected test strategy, rule-pack revision, and material assumptions.
2. **输入与语义完整性** — artifact inventory, CircuitInspector semantic coverage, diagnostics, conflicts, and missing revisions.
3. **制造测试策略矩阵** — method, disposition, target faults, prerequisites, evidence, residual gaps, and status.
4. **自动几何检查** — analysis identifiers, rule results, measured values, citations, and evidence links.
5. **原理图、边界扫描、烧录与 FCT 审查** — document-backed findings and factory-confirmation items.
6. **问题清单** — one row per finding with ID, severity, status, verification mode, area, evidence, authority, impact, action, and owner.
7. **待确认与缺失资料** — approvals, conflicts, missing inputs, factory trials, and acceptance evidence required to close `REVIEW`.
8. **报告与问题定位** — CircuitInspector HTML report, Viewer link, SVG/PNG evidence, or an explicit statement that automated evidence was not run.

Prioritize actions by safety and damage risk, blocked manufacturing coverage, escape risk, fault-localization impact, recurring fixture/test cost, and implementation effort. Never describe static analysis as successful factory, fixture, powered, throughput, or production-line acceptance.
