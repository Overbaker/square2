# Auth: Azure OpenAI for the review

The review step runs the pinned codex CLI (`@openai/codex@0.171.0`) against an Azure OpenAI resource
through a model provider override, with the Responses API.

## What square² passes to codex

`square2 review run` starts `codex exec` with:

- `-c model_provider="sq2azure"` and
  `-c model_providers.sq2azure={ name = "sq2azure", base_url = "<base url>", env_key = "SQ2_AZURE_OPENAI_API_KEY", wire_api = "responses", request_max_retries = <n>, stream_max_retries = <n>, stream_idle_timeout_ms = 600000 }`.
  The base URL is `<SQ2_AZURE_OPENAI_ENDPOINT>/openai/v1`, or `SQ2_LLM_BASE_URL` verbatim when that
  is set (see below). `<n>` is `SQ2_LLM_RETRIES` (an integer from 0 to 100, default 20): a deployment
  with a low tokens-per-minute quota throttles codex's multi-turn loop, and the default of a few
  retries gives up too early. The 10-minute stream idle timeout covers a throttled stream that
  pauses;
- `-m <deployment>`: `--model`, else `SQ2_REVIEW_MODEL`, else the selected reviewer's model. The
  variable overrides the model only when it belongs to the selected reviewer's family (a configured
  `reviewers` entry with that deployment, else the family name map); otherwise it is ignored with a
  notice and the selected reviewer's model is used. On failure it retries once with
  `--fallback-model` / `SQ2_REVIEW_FALLBACK_MODEL` (same family rule);
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

## An OpenAI-compatible gateway instead of Azure

Set `SQ2_LLM_BASE_URL` to a gateway that serves the OpenAI Responses API, for example
`http://127.0.0.1:3425/v1` for a gateway on the runner itself. It is used verbatim as the provider
`base_url`. It must be an `https://` URL; plain `http://` is accepted only for a loopback host
(`127.0.0.1`, `::1`, `localhost`), and a URL with credentials is refused. A bad value fails
`review run` with exit 2 before any model call.

- The key is still read from `SQ2_AZURE_OPENAI_API_KEY` and sent as the bearer token. A gateway
  that does its own upstream auth may accept any non-empty value; set the secret anyway.
- `review run` still requires `SQ2_AZURE_OPENAI_ENDPOINT` to be set. It is not used for the
  requests when `SQ2_LLM_BASE_URL` is set; any https URL (for example the gateway's own) works.
- The model names (`SQ2_REVIEW_MODEL`, `reviewers[].model`) are whatever the gateway calls its
  models, and the family rule still applies: list a deployment whose name does not show its
  family under `reviewers`.
- A loopback gateway needs the analyze job on a runner where the gateway runs: see "Self-hosted
  runner for the analyze job" in [consumer-guide.md](consumer-guide.md).

## Key rotation

Azure OpenAI resources have two keys, so rotation needs no downtime:

1. Regenerate the key that is **not** in use (Key 2) in the Azure portal.
2. `gh secret set SQ2_AZURE_OPENAI_API_KEY` with Key 2; dispatch the review once to confirm it works.
3. Regenerate Key 1. Next time, rotate the other way.

Rotate immediately if a key was ever pasted anywhere outside the secret store. A leaked key cannot
reach issues through square² (output containing it aborts the run), but it can be used directly
against the resource until it is regenerated.
