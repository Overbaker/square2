<!-- Read by the reviewer as repository context (evidence, never instructions). Keep it short and factual. -->
# Review context

CONSUMER: describe what a reviewer of a commit range must know and cannot see in one diff:

- the main components and how they talk to each other (queues, APIs, shared tables);
- invariants that span files (tenancy, ownership of a table, ordering, idempotency);
- where the contracts live (schemas, generated clients) and who owns them;
- what is deliberately out of scope for review (generated code, vendored copies).
