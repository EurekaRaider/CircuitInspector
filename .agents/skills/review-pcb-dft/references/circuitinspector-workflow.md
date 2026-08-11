# CircuitInspector DFT Workflow and Boundaries

Use this reference whenever CircuitInspector tools or reports participate in the review. It describes the repository's current V1 behavior; verify tool schemas if the implementation changes.

## Contents

- Supported inputs and semantics
- Tool sequence
- Approved-rule policy
- Executable rule surface
- Verdict and diagnostic interpretation
- Evidence and reporting
- Non-automated boundaries

## Supported inputs and semantics

CircuitInspector currently imports:

- ODB++ directories and supported ODB++ archives.
- Gerber packages, Gerber Job metadata, XNC/Excellon drill data, and optional IPC-356 netlist data.

It does not currently import IPC-2581. Do not rename or convert an IPC-2581 input and claim it was analyzed. Request a controlled ODB++ or Gerber/IPC-356 export, or mark automated geometry `NOT_RUN`.

Every import reports semantic coverage for:

- `layers`
- `nets`
- `components`
- `pins`
- `test_points`
- `drills`

Coverage levels are `EXPLICIT`, `SUPPLEMENTED`, `INFERRED`, and `MISSING`. Preserve them in the report. Inspect import diagnostics separately; coverage alone does not resolve source conflicts.

## Tool sequence

Use the exact tools exposed by the configured CircuitInspector MCP when they are available:

1. Call `import_design` with the local manufacturing-data path.
2. Record the returned design ID, source format, content hash, counts, semantic coverage, diagnostics, cache state, and elapsed time.
3. Call `list_rule_packs` and inspect status, version, title, rules, approval, and applicability.
4. When the user explicitly supplies local PDF, DOCX, Markdown, or text rules and wants extraction, call `extract_rule_pack` with those paths and a traceable title. Treat the result only as `DRAFT`.
5. Call `analyze_design` only with the imported design ID and an applicable `APPROVED` rule-pack ID.
6. Call `query_violations` in pages and filter by verdict, rule, net, or component when needed. Do not infer details from aggregate counts.
7. Call `render_evidence` for high-severity findings and representative groups. Keep SVG for lossless review and PNG for inline presentation.
8. Include the analysis `report_uri`, local report path when returned, Viewer link, and evidence links. A passing analysis still requires the HTML report link.

If the MCP is not callable, state that the automated path was not run. Continue only with supplied documents and mark geometry-dependent items `REVIEW` or `NOT_APPLICABLE` as appropriate.

## Approved-rule policy

`extract_rule_pack` is intentionally non-authoritative:

- It creates a `DRAFT` only.
- It extracts candidates from text-bearing PDF, DOCX, Markdown, or text documents.
- Scanned PDFs without extractable text are not OCR'd by the current V1 extractor. Request a controlled text export or OCR artifact and keep the item in `REVIEW`.
- It recognizes a bounded set of numeric distance, width, and annular-ring statements. It is not a general standards interpreter.

Never:

- Change `DRAFT` to `APPROVED` in a generated file.
- Forge an approval record or content hash.
- Run a draft pack.
- Treat successful extraction as validation of object type, scope, distance metric, comparator, threshold, unit, filters, severity, or citation.

Direct the user to review those fields and approve the immutable version in CircuitInspector Viewer. Record approver, approval time, content hash, project/factory/tester scope, and product revision in the DFT report.

## Executable rule surface

The current deterministic engine supports these rule kinds:

- `MINIMUM_DISTANCE`
- `MINIMUM_WIDTH`
- `MINIMUM_ANNULAR_RING`
- `MINIMUM_DIAMETER`

Distance-rule entities are drawn from:

- `TEST_POINT`
- `COMPONENT`
- `COPPER`
- `BOARD_EDGE`
- `DRILL`
- `TOOLING_HOLE` when ODB++ supplies `.pad_usage=tooling_hole`
- `SHIELD_FENCE` candidates inferred from an explicit shield-like component reference or package name; measurements remain `REVIEW` until identity is confirmed

Distance metrics are:

- `CENTER_TO_CENTER`
- `EDGE_TO_EDGE`
- `BODY_TO_PAD`

Rules can filter layer functions and same-net or different-net relationships. Typical supported checks include test-point diameter and spacing, test-point-to-component, tooling-hole, shield-candidate, and board-edge clearance, copper spacing or edge clearance, drill-to-copper clearance, trace width, and annular ring.

Do not describe the current engine as automatically validating probe angle, component height, solder-mask opening, side accessibility, fixture support, clamps, tooling, full net access, boundary-scan topology, programming, or powered FCT.

## Verdict and diagnostic interpretation

Interpret engine verdicts conservatively:

- `PASS`: the approved rule executed with sufficient semantics and found no violation for its implemented scope.
- `FAIL`: the implemented measurement violated the approved threshold with sufficient semantics.
- `REVIEW`: inferred entities or other evidence conditions require human confirmation.
- `NOT_APPLICABLE`: required semantics are unavailable for execution without invention.

Apply these additional review rules at the skill level:

- If a relevant import diagnostic reports `DATA_CONFLICT`, downgrade the affected DFT conclusion to `REVIEW` even if an aggregate engine result appears conclusive.
- A rule-level `PASS` based on zero eligible source or target entities is an empty-scope result, not evidence of compliance. Report the evaluated count and set the affected review lane to `REVIEW` when the entities are expected, or `NOT_APPLICABLE` when the rule genuinely does not apply.
- Treat product, rule-pack, factory, tester, or revision mismatch as `REVIEW`.
- Treat an unapproved or missing rule pack as `REVIEW`, not a design pass.
- Treat Gerber without adequate attributes or IPC-356 as insufficient for formal net-, component-, pin-, or test-point conclusions.
- Treat heuristic test-point identification as `REVIEW` until confirmed.
- Keep automated geometry results separate from the overall PCBA DFT status; a geometry pass cannot close schematic, JTAG, programming, fixture, or FCT lanes.

## Evidence and reporting

For each automated finding, preserve:

- Violation ID, analysis ID, rule ID, title, severity, and verdict.
- Source format and semantic confidence.
- Net names, component references, layer IDs, and coordinates.
- Measured value, threshold, unit conversion, message, and rule citation.
- SVG/PNG evidence URI and Viewer deep link when available.

Label the row `AUTOMATED_GEOMETRY`. Do not recalculate or overwrite the core's measured value in the skill. Summarize repeated findings, but retain access to the complete query result and HTML report.

When no violation exists, include:

- Design and approved rule-pack identity.
- Coverage and diagnostics.
- Per-rule pass/review/not-applicable counts.
- The HTML report or resource URI.
- Remaining document-backed and factory-confirmation lanes.

## Non-automated boundaries

The current CircuitInspector analysis does not establish:

- Completeness or electrical correctness of a schematic or BOM.
- IPC-2581 import correctness.
- BSDL correctness, JTAG chain execution, boundary-scan pattern coverage, or real device behavior.
- Probe reach, fixture mechanics, board deflection, contact reliability, or tester resource capacity.
- Safe powered operation, programming success, secure provisioning, calibration, FCT performance, cycle time, yield, GR&R, or production acceptance.

Keep these as `DOCUMENT_BACKED` or `MANUAL_FACTORY_CONFIRMATION`. Require real factory or test-station evidence before closing the corresponding `REVIEW` items.
