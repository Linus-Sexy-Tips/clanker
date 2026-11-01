# Security policy

## Reporting

Report vulnerabilities privately in the repository's **Security** tab under **Report a vulnerability** ([direct link](https://github.com/Linus-Sexy-Tips/clanker/security/advisories/new)).

Include what you found, how to reproduce it, the version or image digest, and the impact. Expect a first reply within a day. The advisory is published with the fix and credits the reporter unless they decline.

Only the latest release gets security fixes.

## Scope

In scope: the code in this repository, the image `ghcr.io/linus-sexy-tips/clanker`, and the release workflow that builds and signs it. For example:

- using the bot without being allowed, or where it shouldn't answer
- getting past the spending caps, or spending without a ledger entry
- making it ping users, roles, `@everyone`, or `@here`
- secrets or message text in logs, on disk, or in error messages (except message text with `log.level = "debug"`)
- chat messages, web pages, or model output making the bot do more than write a reply
- weaknesses in the image, its signature, or its provenance

Out of scope:

- bugs in Fluxer, the Anthropic API, or a dependency (report upstream, and here too if Clanker must change)
- jailbreaks and wrong answers, unless they lead to a problem above
- attacks that need control of the host, the config, or the secrets
- load an allowed user can cause within the operator's limits
