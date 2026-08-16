# Merge queue integration

Conflict Radar keeps `conflict-radar-ci` as the enforcement command and registers its `semantic-desync` job as a required merge-queue check. The queue provider supplies serialization; Conflict Radar does not implement its own queue.

## Availability

Mergify's GitHub App and Merge Queue product are active on `Ansell-OK/conflict-radius`. The configuration was validated with `mergify 2026.8.11.1`, then exercised through two real pull requests. Both entered `conflict-radar-verified` only after `semantic-desync` passed and were merged by the queue. Graphite remains untested.

## Graphite

In the Graphite dashboard for the repository, add the GitHub check named `semantic-desync` to the merge queue's required checks. Configure the queue so the check must pass on the queued commit before merge. No Graphite-specific repository file is added because this setting is managed by Graphite.

## Mergify

The live `.mergify.yml` creates a queue whose entry and merge conditions both require `semantic-desync`. `.mergify.example.yml` is retained as a reusable template.

Validate future changes locally with:

```bash
mergify config validate --config-file .mergify.example.yml
```

Confirm the exact check name in GitHub after the workflow runs once. GitHub may display it with workflow context depending on repository settings.

Queue admission was verified with the provider-supported command:

```text
@Mergifyio queue
```

The configured `pull_request_rules` action matched in CLI simulation but did not automatically enqueue the live test PR. Treat command/dashboard admission as the tested path until automatic rules execution is separately enabled and observed for the account.

## Queue comparison set

The current standalone CI path discovers other open pull requests through GitHub or accepts `CONFLICT_RADAR_OPEN_PRS`. In a live merge-queue integration, the latter input should be generated from the provider's ordered queue state so the comparison set contains only changes ahead of the queued pull request.

That adapter is intentionally not implemented without a provider environment. It must be validated against Graphite's or Mergify's real queue-state API before replacing GitHub enumeration. Conflict Radar does not provide queue serialization itself.
