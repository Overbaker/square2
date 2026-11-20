# Auth: Azure OpenAI for the review

The review step runs the pinned codex CLI (`@openai/codex@0.171.0`) against an Azure OpenAI resource
through a model provider override, with the Responses API.

## What square² passes to codex

`square2 review run` starts `codex exec` with:

- `-c model_provider="sq2azure"` and
  `-c model_providers.sq2azure={ name = "sq2azure", base_url = "<SQ2_AZURE_OPENAI_ENDPOINT>/openai/v1", env_key = "SQ2_AZURE_OPENAI_API_KEY", wire_api = "responses" }`;
- `-m <deployment>`: `--model`, else `SQ2_REVIEW_MODEL`, else the configured reviewer; on failure it
  retries once with `--fallback-model` / `SQ2_REVIEW_FALLBACK_MODEL`;
- `--ignore-user-config --ignore-rules --ephemeral --sandbox read-only`, a fresh `CODEX_HOME`, and an
  environment that contains the key and the endpoint and nothing else secret.

Both deployments must belong to the reviewer's family (a deployment name that does not show its
family must be listed under `reviewers` in `.square2/config.yaml`).

## Setup

1. Create (or reuse) an Azure OpenAI resource and deploy the reviewer model; note the deployment names.
2. Repository variables: `SQ2_AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/`,
   `SQ2_REVIEW_MODEL=<deployment>`, optionally `SQ2_REVIEW_FALLBACK_MODEL=<deployment>`.
3. Secret, from stdin: `gh secret set SQ2_AZURE_OPENAI_API_KEY` (paste, then Ctrl-D). Never write the
   key to a file, a log or a chat.

Local pilot: export the same two variables in the shell for one command; the key is read from the
environment only.

## Key rotation

Azure OpenAI resources have two keys, so rotation needs no downtime:

1. Regenerate the key that is **not** in use (Key 2) in the Azure portal.
2. `gh secret set SQ2_AZURE_OPENAI_API_KEY` with Key 2; dispatch the review once to confirm it works.
3. Regenerate Key 1. Next time, rotate the other way.

Rotate immediately if a key was ever pasted anywhere outside the secret store. A leaked key cannot
reach issues through square² (output containing it aborts the run), but it can be used directly
against the resource until it is regenerated.
