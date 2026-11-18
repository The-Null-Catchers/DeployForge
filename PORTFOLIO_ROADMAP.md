# DeployForge portfolio roadmap

Baseline reviewed on November 17, 2026. Repository roadmap published on November 18, 2026.

This roadmap applies to this repository and follows the shared Null Catchers portfolio plan. Verify the documented state against the current code and runs before starting work.

**Estimated initial demo effort** 25–45 hours for a developer familiar with the project. The estimate excludes external reviews, store accounts, target environment setup, and later milestones.

## Project priorities

**Documented state** The control plane and Go runner build a specified commit, activate releases after a health check, and support rollback. Current CI checks were retrieved, and the acceptance report and progress notes contain historical results that need fresh evidence.

**P0 — Demo** Run Docker acceptance on the current revision and record promotion, failed promotion, and rollback.

**P1 — Validation and depth** Verify the GitHub App and DNS/TLS on a test deployment when available. Rehearse backup and restore of data and encryption keys, restart the runner during a build, and check logs for secret exposure.

**P2 — Later** Consider preview environments or blue/green deployment for a specific case. A default-branch rename requires separate coordination of references and protections. Flutter is outside this demo.

**Acceptance criteria** Only healthy releases activate. Rollback reuses an owned image. Build cancellation stops processes and cleans temporary state.

**Demo scenario** Deploy a healthy commit → reject an unhealthy release → restore the prior version. [Repository and default branch](https://github.com/The-Null-Catchers/DeployForge), [Progress](https://github.com/The-Null-Catchers/DeployForge/blob/claude/deployforge-platform-hppvk5/docs/PROGRESS.md).

## Next milestones

The [historical acceptance report](docs/acceptance-report.md) records 14 passing checks on September 29, 2026.

1. [ ] Run acceptance in a clean Docker environment. Record the commit SHA, Docker and Compose versions, and results.
2. [ ] Deploy A, promote B, then try a release returning HTTP 503. Confirm B stays active and rollback restores A using the original image ID without rebuilding.
3. [ ] Link the result and screenshots from the [progress record](docs/PROGRESS.md) and identify the tested environment.

## Portfolio acceptance checklist

- [ ] Another person can reproduce the primary workflow from a clean checkout using the README and test credentials or fixtures.
- [ ] The demo tells one complete story with a defined user, problem, and saved result.
- [ ] Tests cover the main flow, an important failure, and access boundaries when multiple accounts are involved.
- [ ] Demo data is labeled synthetic and reproducible. Review screenshots and recordings for secrets and customer data.
- [ ] Include four to six real screenshots where appropriate, a 60–120 second recording, and working links. Identify the revision used for capture.
- [ ] The README describes implemented capabilities, setup, architecture, limits, tests, and the demo.
- [ ] A short case study explains two engineering decisions, a considered alternative, and how the system handles an actual failure.
- [ ] Release evidence records the commit SHA, CI, prerequisites, and limits. Performance data includes workload, hardware, and method.
- [ ] Licensing and contributor attribution are settled before distribution. Choose the license for each repository individually.

A hosted demo is optional. Code execution, server administration, and secret management can be demonstrated through a recording and a reproducible isolated environment. Keep public demo access scoped to the activities it needs.

## Implementation and follow-up

- Break P0 into tasks with expected behavior, acceptance criteria, and a suitable test.
- Verify existing functionality first. Update this plan when evidence tied to a commit or PR closes a milestone.
- Record the fixture source, the revision used for evidence, and the tested limits.
- Review the final diff and verify required checks for its exact SHA before merging. Follow branch protection.
- For documentation-only changes with no applicable workflow, verify content and links and record the checks actually performed.
- Tie performance, security, and readiness claims to supporting evidence.
