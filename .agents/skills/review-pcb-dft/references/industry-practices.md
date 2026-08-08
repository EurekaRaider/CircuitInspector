# PCB/PCBA DFT Industry Practices

Use this reference to select a manufacturing-test strategy and perform the non-geometric review. These are process and review practices, not universal numeric limits.

## Contents

- Source and rule policy
- Lifecycle and coverage planning
- Manufacturing-data package
- Probe and fixture access
- Electrical controllability and observability
- Boundary scan and JTAG
- Programming and provisioning
- Functional test
- Evidence and closure

## Source and rule policy

Use public standards and guidance to define the review framework. Obtain licensed standards, customer requirements, and factory/tester documents when an exact requirement or numeric threshold is needed.

Primary public orientation sources:

- [IPC-2231A, DFX Guidelines public table of contents and scope](https://www.ipc.org/TOC/IPC-2231A_TOC.pdf) — formal DFX process framework covering testability across design stages and checklists.
- [IEEE P1149.1 public project page](https://standards.ieee.org/ieee/1149.1/10977/) — Test Access Port and boundary-scan architecture scope. Verify the applicable published revision for the product.
- [Keysight Boundary Scan DFT Guidelines](https://www.keysight.com/us/en/assets/3126-1349/application-notes/Boundary-Scan-Design-for-Testability-DFT-Guidelines.pdf) — implementation considerations including chain integrity, TAP distribution, voltage domains, debug flexibility, and BSDL verification.
- [Keysight ICT overview](https://www.keysight.com/blogs/en/tech/educ/2024/in-circuit-test) — relationship among bed-of-nails ICT, flying probe, limited access, fixture sides, and complementary techniques.
- [Siemens proactive PCB DFT practices](https://blogs.sw.siemens.com/electronic-systems-design/2022/05/11/proactive-design-for-test-dft-best-practices/) — early DFT planning and risk-based net prioritization.
- [IPC-2581 Consortium](https://www.ipc2581.com/) — public description of the PCB and assembly manufacturing-data exchange standard.

Confirm source revision, scope, product class, test technology, equipment, and factory applicability. Do not convert public examples into mandatory limits without that confirmation.

## Lifecycle and coverage planning

Start DFT during architecture and schematic design, not after placement and routing. Assign owners for hardware design, test engineering, firmware, manufacturing, fixture design, and quality.

Define the manufacturing defect model before selecting equipment. At minimum, consider:

- Bare-board opens and shorts.
- Assembly opens, shorts, solder defects, wrong/missing/reversed components, and wrong values.
- Power-rail, clock, reset, oscillator, boot, and configuration faults.
- Digital interconnect faults, including limited-access devices and connectors.
- Blank, corrupt, wrong-version, misconfigured, or incorrectly secured programmable devices.
- Analog, sensor, actuator, interface, calibration, and end-to-end functional faults.

Build a method-to-fault matrix. Count a fault class as covered only when the method has the required access, stimulus, observation, limits, diagnostics, and production asset. State overlap and residual gaps.

Use volume and change rate as inputs, not as automatic answers:

- Prefer flying probe when layouts change frequently or fixture non-recurring engineering dominates.
- Consider ICT when stable volume, diagnostic needs, and physical access justify the fixture.
- Use boundary scan to recover suitable digital interconnect coverage where physical access is limited; do not treat it as a universal replacement for powered or analog testing.
- Use FCT for product behavior that structural methods cannot establish.

Review again at schematic freeze, placement review, routing review, design release, fixture release, pilot build, and any product/factory/tester revision.

## Manufacturing-data package

Keep every artifact aligned to the same product and panel revision. Prefer semantically rich data; record any conversion or loss.

Include, as applicable:

- ODB++ or an agreed intelligent manufacturing-data package.
- Gerber/Excellon plus IPC-356 when Gerber is the exchange format and net/test intent is needed.
- IPC-2581 when supported by the design and manufacturing toolchain.
- Native or controlled schematic, BOM/AVL, placement, assembly drawings, stack-up, netlist, test-point attributes, variants, and panel data.
- Test requirements, factory/tester limits, fixture rules, BSDL files, device programming specifications, firmware images, FCT procedures, calibration data, and controlled expected results.

Check completeness, internal consistency, units, coordinate origin, side/mirror transforms, panel step-repeat, component and net naming, variant population, and revision/hash traceability. Schema-valid data is not proof of correct design intent or manufacturability.

CircuitInspector currently automates ODB++ and Gerber-family inputs, not IPC-2581. For an IPC-2581-only delivery, request an agreed supported export or mark automated geometry `NOT_RUN`; do not claim it was imported.

## Probe and fixture access

Verify each required electrical node has an allowed contact strategy. Prefer stable, intentional contact targets over opportunistic contact to component leads. Confirm with the actual tester and fixture supplier:

- Allowed target types, target shape and finish, mask opening, contamination risk, and probe technology.
- Minimum target size, pitch, target-to-target spacing, probe angle, approach envelope, and maximum probe density.
- Component-body, tall-component, connector, board-edge, clamp, support-pin, tooling-hole, fiducial, and keep-out clearances.
- Allowed test side or sides. Prefer one-side bed-of-nails access when it meets coverage and product constraints because two-sided fixtures add cost and complexity.
- Mechanical support beneath probe-force regions, board deflection, panel rails, breakaways, depanelization effects, and repeatable orientation.
- Ground and guard contacts, Kelvin or force/sense access, shielding, and measurement references where the test method requires them.
- Test-pad and stub impact on controlled-impedance, RF, high-speed, sensitive analog, or low-leakage nets.

Use the factory's exact numeric rules. When unavailable, identify candidate risks as `REVIEW` and request fixture/tester confirmation.

## Electrical controllability and observability

Provide safe ways to place the board in deterministic test states and observe required responses.

Review:

- Power-rail and ground access, current-limited injection, discharge, sequencing, brownout behavior, inrush, and safe shutdown.
- Prevention of back-powering through I/O, programming, debug, protection, or measurement paths.
- Isolation of supplies, loads, clocks, buses, drivers, actuators, and external interfaces where test stimulus would otherwise contend or mask faults.
- Accessible reset, boot straps, test modes, enables, clocks, interrupts, and critical analog nodes.
- Pull states and default states while processors, programmable logic, or peripherals are blank or held in reset.
- Safe handling of high voltage, stored energy, motors, heaters, relays, RF transmitters, lasers, batteries, and other hazardous outputs.
- Repeatable preconditions and cleanup so one failed test does not contaminate later results or the next unit.

Do not equate an exposed signal with a testable signal. Establish stimulus, observation, limits, loading, safety, and diagnostic value.

## Boundary scan and JTAG

Confirm the exact device, package, silicon revision, and BSDL file. Treat a data-sheet claim of JTAG support as insufficient evidence.

Review:

- Chain topology, device ordering, instruction-register lengths, bypass behavior, optional-device and variant handling, and multi-board paths.
- Accessible TCK, TMS, TDI, TDO, optional TRST, reset, and required power/reference connections.
- Pull-ups or pull-downs, reset interaction, clock signal integrity, termination, connector or pad assignment, cable/fixture effects, and test-frequency assumptions.
- Voltage domains, translators, open-drain signals, differential or AC-coupled networks, non-scan devices, analog boundaries, and inaccessible clusters.
- Debug versus manufacturing ownership, isolation from field connectors, security state, programming use, and recovery after interruption.
- BSDL syntax plus physical verification, chain-detect execution, interconnect pattern generation, diagnostic resolution, and measured fault coverage.

Report separate coverage for boundary-scan interconnect, cluster, memory, flash/programming, and non-scan residuals. Do not report a single boundary-scan percentage without its fault model and exclusions.

## Programming and provisioning

Define the production state transition from blank hardware to a uniquely identified, verified, and recoverable unit.

Review:

- Physical and electrical programming access, power/current requirements, reset and boot configuration, interface speed, and signal integrity.
- Authoritative image identity, product/variant compatibility, hashes or signatures, configuration data, and read-back or verify behavior.
- Serial number, MAC address, certificates, keys, calibration data, and other unique identity allocation with duplicate prevention.
- Secret handling, least privilege, audit trail, retry rules, quarantine, recovery, and the point at which irreversible locks or fuses are applied.
- Firmware behavior required for ICT/FCT and whether production test still works after the final security state is applied.
- Logged linkage among unit identity, board revision, image revision, test-station revision, operator or automation identity, timestamp, and result.

Never expose credentials or secret material in the review report. Review the process and evidence controls instead.

## Functional test

Define observable requirements and production limits before writing a station procedure.

Review:

- Safe and keyed connection, mating-cycle life, strain relief, grounding, shielding, interlocks, and prevention of wrong orientation.
- Stimulus and observation for each required interface, sensor, actuator, power mode, communication path, alarm, and safety function.
- Loads, loopbacks, golden peripherals, simulated sensors, fixtures, adapters, and environmental conditions.
- Calibration and compensation, instrument uncertainty, fixture/cable losses, guard bands, tolerances, warm-up, drift, and golden-unit correlation.
- Test ordering, deterministic initialization, retries, teardown, discharge, throughput target, bottlenecks, and parallelization assumptions.
- Failure messages, diagnostic granularity, raw measurements, limits, station and software revision, operator guidance, and repair feedback.

Do not call a scripted nominal demonstration adequate FCT. Include negative cases, boundary conditions, fault isolation, repeatability, and production logging appropriate to the product risk.

## Evidence and closure

Close a finding only with evidence appropriate to its verification mode:

- `AUTOMATED_GEOMETRY`: approved rule, matching design hash, measured value, threshold, semantic coverage, analysis ID, and rendered evidence.
- `DOCUMENT_BACKED`: controlled source, exact revision or hash, cited location, applicability, and an unambiguous comparison.
- `MANUAL_FACTORY_CONFIRMATION`: named factory/tester/fixture, confirmed rule or capability, trial artifact, approver, date, and affected product revision.

Require real fixture or station evidence for probe repeatability, board deflection, powered safety, measurement capability, cycle time, gauge repeatability, pilot yield, and production acceptance. Static review cannot establish those outcomes.
