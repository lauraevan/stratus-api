# Raccoon reward collector

Stratus runs `claimEligibleRewards()` immediately after a fresh Raccoon account is created and authenticated.

The collector only calls reward actions explicitly configured here or through `RACCOON_REWARD_ACTIONS`. It does not guess endpoint names, retry rejected one-time promotions, or target hosts other than Raccoon.

## Configuration

Edit `reward-actions.json` or set `RACCOON_REWARD_ACTIONS` to a JSON array.

Each action can contain:

- `name`: log label.
- `probe` (optional): request used to check whether the account is eligible.
- `probe.claimWhen`: condition evaluated against the probe JSON.
- `claim`: the normal provider-approved claim request.
- `claim.successWhen` (optional): additional success condition.

Every request automatically includes the normal Stratus Raccoon account fields:
`sn`, `user_token`, `model`, `version_code`, `version_name`, `device_name`, and `os`.

Only Raccoon-relative paths beginning with `/` are accepted.

### Example shape

```json
[
  {
    "name": "daily-sign-in",
    "probe": {
      "path": "/REPLACE_WITH_PROVIDER_STATUS_PATH",
      "method": "POST",
      "body": {},
      "claimWhen": {
        "path": "data.claimable",
        "equals": true
      }
    },
    "claim": {
      "path": "/REPLACE_WITH_PROVIDER_CLAIM_PATH",
      "method": "POST",
      "body": {},
      "successWhen": {
        "path": "status",
        "in": [200, 201]
      }
    }
  }
]
```

Do not put unverified/guessed paths into production. Use the endpoint names supplied or approved by Raccoon.

## Controls

- `RACCOON_REWARDS_ENABLED=false` disables reward collection.
- `RACCOON_REWARD_ACTIONS=[...]` overrides `reward-actions.json`.
- Logs report each action as claimed, skipped/not eligible, or failed.

## Mail provider order

`smails` is the default first provider. `MAIL_PROVIDER_ORDER`, `MAIL_PROVIDER_ONLY`, and `MAIL_PROVIDER_SKIP` can still override the provider selection.
