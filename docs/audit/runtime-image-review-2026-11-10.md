# SMS-off runtime image review — 10 November 2026

The reviewed candidate uses official Node 22.23.4 on Debian Bookworm, pinned to
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.
The AMD64 manifest is `sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292`.
This is a candidate-publication review, not production risk acceptance or a claim
that every native-library path is safe.

The final local AMD64 runtime is
`sha256:76b297906d10ac7ddd287e28648c57f8b1954f9e819357e3c3822d040f6b13d0`.
It runs as UID 1000, contains 70 migrations and 106 catalogue entries, excludes npm,
and exits 1 with a static message when production configuration is absent. All
setuid/setgid bits in `/usr/bin` and `/usr/sbin` are removed in the runtime stage;
CI verifies this from the final image. The application does not need OS user or
mount administration. The registry publication will build a separately identified
image from the reviewed commit and report its immutable registry digest.

Trivy 0.76.2, using the 9 November vulnerability database, reports **zero Node-package
findings** and **215 Debian package/advisory pairs** across 100 distinct advisory
identifiers: 1 critical, 34 high, 95 medium and 85 low pairs. No Bookworm fixed
version is offered for these entries. Findings are retained, not suppressed.

## Critical and high applicability

| Advisory | Evidence and assessment |
| --- | --- |
| [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853) | Debian explicitly states Bookworm's zlib does not build the affected contrib/minizip binary code. This critical source-package finding does not establish an affected runtime component. |
| [CVE-2026-53613](https://security-tracker.debian.org/tracker/CVE-2026-53613), [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | Restricted privileged mounts require a qualifying fstab entry and attacker-controlled paths. The image has an unconfigured fstab; the app has no volumes/mount operation and runs unprivileged. Runtime setuid/setgid removal further removes the utility privilege transition. This mitigates prerequisites; it is not a package fix. |
| [CVE-2026-53615](https://security-tracker.debian.org/tracker/CVE-2026-53615) | Requires probing attacker-supplied partition metadata. The application does not probe disks, attach block devices or import disk images. |
| [CVE-2026-41992](https://security-tracker.debian.org/tracker/CVE-2026-41992) | Concerns GNU gzip's mixed LZW/LZH CLI decompression. Warthog does not execute gzip or shell commands on uploads. Node's compression implementation is separate. |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | Requires a privileged caller of pathname-based libacl operations. Node/native runtime dependency inspection does not link libacl; the web process does not administer filesystem ACLs. |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | Targets systemd-homed. Shared systemd/udev library packages are present; the affected homed service is not running or provided as an application service. |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | Targets the infocmp CLI and crafted terminal information. The application does not invoke that utility or process terminal definitions. |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | Targets Perl Archive::Tar. A runtime import confirms the module is absent; the app executes neither Perl nor tar extraction. |
| [CVE-2026-76844](https://security-tracker.debian.org/tracker/CVE-2026-76844), [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091) | The scanner has a misleading webpack title for 76844; Debian describes a zlib gz-write error-recovery flaw. Do not dismiss it using that title or the debated version range. `ldd` shows neither Node nor the shipped glibc sharp/libvips binaries dynamically load OS zlib. Bundled native implementations still require their own review; no blanket claim that all zlib usage is fixed is made. |

## Remaining native-library risk

Node and sharp/libvips link glibc and libstdc++, so those packages cannot be dismissed
as unused. The glibc DNS findings
[5435](https://security-tracker.debian.org/tracker/CVE-2026-5435) and
[6238](https://security-tracker.debian.org/tracker/CVE-2026-6238) affect deprecated
debug-printing functions, not ordinary DNS resolution. The separate
[8674](https://security-tracker.debian.org/tracker/CVE-2026-8674) requires an unusually
long resolver search domain or LOCALDOMAIN; check the actual ACA resolver settings
at live acceptance. Privileged-loader
[95818](https://security-tracker.debian.org/tracker/CVE-2026-95818) prerequisites are
reduced by removing setuid/setgid bits.

Residual glibc and C++ reports include allocation, parsing and locale functions.
In particular, [aligned allocation overflow](https://security-tracker.debian.org/tracker/CVE-2026-95619),
[parallel search](https://security-tracker.debian.org/tracker/CVE-2026-114690) and
[boolean-vector sizing](https://security-tracker.debian.org/tracker/CVE-2026-114691)
are not proven unreachable merely because application code is TypeScript. Input
limits and non-root execution reduce some consequences, but this review does not
prove complete native-code reachability or accept those risks for production.
Other retained reports concern OS tools, PAM, crypto libraries and services that
the app does not invoke; package presence alone is not an exploit demonstration.

A comparison scan of official Node 22 Trixie slim found 187 OS pairs, including
48 high, with additional util-linux/sqlite findings. Changing distribution did not
produce a clean image. The candidate keeps the tested Bookworm base; no unstable
packages or unreviewed native-library patches are substituted.

## Release decision

The source and image can be reviewed and published as a candidate behind the
existing `azure-images` gate. **Production approval must explicitly review the
retained OS findings**, the image digest, readiness evidence and maintenance plan.
Do not describe this scan as zero vulnerabilities or automatically waive it based
on severity counts. Re-scan the registry candidate before launch; review vendor
fixes on subsequent image updates. No image publication approves an application
deployment, DNS binding, provider send or billable service upgrade.

Raw scan, dependency inventory, runtime verification and startup evidence are
retained privately in `.delivery/activation-2026-11-10/sms-*`; the scan contains no
runtime credentials or customer data.
