# Merge queue integration

Conflict Radar keeps `conflict-radar-ci` as the enforcement command and registers its `semantic-desync` job as a required merge-queue check. The queue provider supplies serialization; Conflict Radar does not implement its own queue.

## Availability

Neither Graphite nor Mergify is installed on the current repository, and `main` has no protected required checks. The configurations below are templates only and have not been validated against a live provider account.

## Graphite

In the Graphite dashboard for the repository, add the GitHub check named `semantic-desync` to the merge queue's required checks. Configure the queue so the check must pass on the queued commit before merge. No Graphite-specific repository file is added because this setting is managed by Graphite.

## Mergify

Copy `.mergify.example.yml` to `.mergify.yml` only after installing Mergify. The example creates a queue whose entry and merge conditions both require `semantic-desync`.

Confirm the exact check name in GitHub after the workflow runs once. GitHub may display it with workflow context depending on repository settings.

## Queue comparison set

The current standalone CI path discovers other open pull requests through GitHub or accepts `CONFLICT_RADAR_OPEN_PRS`. In a live merge-queue integration, the latter input should be generated from the provider's ordered queue state so the comparison set contains only changes ahead of the queued pull request.

That adapter is intentionally not implemented without a provider environment. It must be validated against Graphite's or Mergify's real queue-state API before replacing GitHub enumeration. Conflict Radar does not provide queue serialization itself.
