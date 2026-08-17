# Security policy

## Supported versions

This project is pre-1.0 and currently targets DeepSeek Harness `0.1.0-rc.7`.

| Version                           | Supported |
| --------------------------------- | --------- |
| Latest `0.1.x` release            | Yes       |
| Older releases and untagged forks | No        |

Security fixes may require upgrading QuickJS, Node.js, DSH, or this package together. The project does not promise backports across incompatible DSH release-candidate APIs.

## Report a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/Linxiushen/dsh-workflow-isolate/security/advisories/new). Do not open a public issue or include exploit details in a public pull request.

Include, where possible:

- affected commit or version and DSH version;
- operating system, architecture, Node.js, and pnpm versions;
- the smallest workflow body and configuration that reproduces the issue;
- the boundary crossed or limit bypassed;
- observed impact and whether child/provider capabilities were involved; and
- any suggested mitigation, without attaching real credentials or sensitive output.

Particularly relevant reports include:

- escape from QuickJS into Node/V8 authority;
- access to an undeclared host object or capability;
- a JSON/prototype boundary bypass;
- a reliable heap, stack, fuel, wall-time, source/result, or child-budget bypass;
- worker/cancellation races that execute work after terminal settlement;
- lifecycle corruption that exposes live run control or leaves unpaired events; and
- exploitable vulnerabilities in the pinned QuickJS/WASM integration.

You should receive an acknowledgement within 72 hours when maintainers are available. Please allow time to reproduce and coordinate a fix before public disclosure. If the report affects an upstream dependency, maintainers may coordinate with that project and ask you to respect its disclosure timeline.

## Security scope

The QuickJS boundary is defense in depth, not a complete operating-system sandbox. The host subagent provider, DSH process, dependencies, installation path, and operating system are trusted components. Authorized behavior through `agent()` can still spend tokens and exercise whatever models, tools, network, filesystem, and credentials the selected provider allows.

The following are generally not vulnerabilities by themselves:

- a child agent performing an action allowed by its provider policy;
- timing differences or resource usage within configured limits;
- a workflow seeing its own `args` or child result data;
- differences between QuickJS and V8 error messages or JavaScript behavior; and
- denial of service that requires already controlling a trusted host dependency or operating system.

See the [Security model](docs/security-model.md) and [Threat model](docs/threat-model.md) for the exact trust assumptions and residual risks.
