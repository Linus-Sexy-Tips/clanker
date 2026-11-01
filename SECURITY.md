# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Linus-Sexy-Tips/clanker/security/advisories/new)). Don't open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, the version or image digest you tested, and what an attacker could do with it. You should get a first reply within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Update to it before reporting, if you can.

## Scope

In scope: the code in this repository, the container image published at `ghcr.io/linus-sexy-tips/clanker`, and the release workflow that builds and signs it. Examples:

- using the bot without being allowed, or in a community, channel or DM where it shouldn't answer
- getting past the spending caps, or making it spend money without a trace in the ledger
- making it ping users, roles, `@everyone` or `@here`
- secrets or message text ending up in logs (outside debug level), on disk or in error messages
- anything that lets chat messages, web pages or model output make the bot act beyond writing a reply
- weaknesses in the container image, its signature or its provenance

Out of scope:

- bugs in Fluxer, the Anthropic API or a dependency (report them upstream; tell us if Clanker needs to change because of one)
- what the model writes, such as jailbreaks or wrong answers, unless it leads to one of the problems above
- attacks that need control of the host, the config file or the secrets
- load that an allowed user can cause within the limits the operator configured
