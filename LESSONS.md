# Lessons

What the port taught, including the mistakes. The Python original has its own
[LESSONS.md](../knowledge-desk/LESSONS.md); this file only covers what moving the
code to TypeScript surfaced.

## 1. A synchronous Fastify hook hangs every request, not just the ones it rejects

`authRateLimit` started life as a plain synchronous function:

```ts
export function authRateLimit(request: FastifyRequest, reply: FastifyReply): void {
  const [allowed] = authLimiter.check(...)
  if (!allowed) void reply.code(429).send({ detail: 'too many attempts' })
}
```

Every request to `/auth/signup` then hung until the client gave up. Thirty seconds
each, twenty-two tests, no error and nothing in the Postgres log because no query
was ever issued.

Fastify decides how to run a hook from its arity. Three parameters means callback
style and the hook must call `done`; fewer means promise style and Fastify awaits
the return value. A synchronous two-parameter hook returns `undefined`, so Fastify
has neither a promise to await nor a `done` to wait for, and the chain stops.

The part that made it slow to find is that it hangs on the **success** path too.
A limiter that broke only when it fired would have been obvious. This one broke
every request to every route that used it, while `/healthz` and the 401 on `/ask`
both passed, because those hooks happened to be `async`.

**Expected:** a hook that returns nothing continues the chain.
**Actual:** a hook that returns nothing and is not `async` stalls it.
**Next time:** every Fastify hook is `async`, with no exceptions for ones that
only read. The arity rule is invisible at the call site, so the only defence is a
habit.

## 2. node-postgres has no `configure` hook, and the race is silent

psycopg's pool takes a `configure` callback and waits for it before handing the
connection out. node-postgres fires a `connect` event with no way to make the pool
wait, so this:

```ts
pool.on('connect', (client) => {
  void pgvector.registerTypes(client)
  void client.query('set hnsw.iterative_scan = relaxed_order')
})
```

races the first real query on that client. It announced itself as a deprecation
warning — "Calling client.query() when the client is already executing a query" —
which is a mild way to describe pgvector's type registration losing a race and a
vector column coming back as a string.

The fix is a `WeakSet` of already-configured clients and an `await` on first
checkout, which is what psycopg was doing for free.

## 3. The mock embedder had to become a Mersenne Twister

`MockEmbedder` promises that the same text always produces the same vector, and it
gets that from `random.Random(seed)`. Node has no seedable RNG, and every package
that offers one offers a *different* generator, which would have meant a corpus
embedded by the Python app was unreadable by this one against the same database.

So CPython's Mersenne Twister is written out: `init_by_array` seeding, the 53-bit
`random()`, `uniform()`. It matches to twelve decimal places. Roughly eighty lines
to avoid regenerating fixtures and to keep one database usable from both apps, and
I would do it again, but it is the single largest piece of code in this repository
that exists purely because of the language change.

## 4. Every string index in the injection defence had to move to code points

Python indexes strings by code point. JavaScript indexes by UTF-16 unit. The
normalizer's whole job is to find a span in folded text and cut the corresponding
bytes out of the original, and an offset map built on JavaScript string indices
drifts by one for every astral character before the span.

Concretely: a document containing one emoji ahead of a forged `<<<UNTRUSTED_DOCUMENT>>>`
marker gets its replacement marker written one position late, and the further into
the document the forgery sits the worse it gets. A defused document that is
silently mis-defused is worse than one that is not defused at all, because
everything downstream reports success.

`normalize.ts` therefore works on `[...text]` throughout, and `foldedIndices`
converts a `RegExp` match's UTF-16 offsets before they reach the origin map.
`RegExp.exec` reports UTF-16 offsets even under the `u` flag, which is the
specific trap.

Verified against the Python implementation on the confusable, invisible, and emoji
cases before anything was built on top of it.

## 5. `round()` goes to even and `toFixed()` does not

Python's `round(x, 6)` breaks a tie to the even digit. `toFixed(6)` rounds half
away from zero. On one answer that is a millionth of a dollar. These numbers are
summed into a per-org rolling budget and a platform daily cap, so it does not stay
a millionth, and the two apps would disagree about whether a tenant was over its
limit.

`round6` in `numbers.ts` is four lines and exists entirely for this.

## 6. `str.casefold` has no JavaScript equivalent

The output check compares a model's quoted evidence span against the passage it
cites, case-insensitively. `toLowerCase` is not `casefold`: it leaves the German
sharp s and the Greek final sigma alone. A passage saying "straße" quoted back as
"strasse" is the model copying correctly, and `toLowerCase` alone reports it as an
unsupported citation.

Two `replaceAll` calls, spelled out rather than pulled from a package, because a
reader can check two substitutions and cannot check a dependency.

## 7. `zip(strict=True)` has no equivalent either, and the default is worse

The worker zips chunk texts against their embeddings. Python's
`zip(texts, embeddings, strict=True)` raises when the lengths differ; JavaScript
zipping by index produces `undefined` and carries on. The Python comment explains
exactly why that matters — a short embedding list marks a document ingested
holding a subset of its chunks, which is a permanent invisible hole in retrieval
that nothing downstream ever sees a reason to retry.

So the length check is explicit and throws. It is the one place in the port where
removing a language feature required adding a guard rather than a translation.

## 8. The Langfuse JavaScript SDK is not the Python SDK with different casing

Three things, and none of them announce themselves:

- Tracing runs on OpenTelemetry. `startObservation` writes to an OTel tracer, and
  with no registered span processor the spans go nowhere. `init` has to stand up a
  `NodeSDK`. The Python client needs nothing of the kind.
- The environment variable is `LANGFUSE_BASE_URL`. `LANGFUSE_HOST`, which the
  Python SDK reads and which this project's `.env.example` still listed, is
  silently ignored — set it and you ship traces to `cloud.langfuse.com` believing
  you are self-hosting.
- There is no `auth_check()`. The obvious substitute, `client.api.health.health()`,
  returns `{"status":"OK"}` for deliberately bogus keys, so it checks nothing.
  Fetching the project is the request Python's check actually makes.

Also worth knowing: a span processor constructed without credentials does not
throw, and creating spans works fine. It is `forceFlush()` that rejects with a
401, from a background timer, as an unhandled rejection. Observability taking down
the thing it was watching is the exact failure the Python module's "every method
is exception-proof" comment was written to avoid, arriving through a door that
module did not have. Registration is gated on the keys being present rather than
left to fail.

## 9. Typing passages as `unknown` pushed eight `String()` calls into the wrong layer

The first draft of `Context` mirrored the Python dict: `path?: unknown`,
`text?: unknown`. Every consumer then wrote `String(c.text ?? '')`, and the linter
was right to object — `String()` on an `unknown` yields `"[object Object]"`, which
would have gone into a prompt and into a citation check as if it were a passage.

The fix was not to silence the rule. It was to do the coercion once, in
`retrieval.search`, where database rows become passages. Everything downstream now
reads `c.text`, and a row that arrives without one is a bug at a single boundary
rather than eight silent empty strings further in. The Python version has the same
shape of problem and no type checker to point at it.

## 10. `for await ... of` closes the generator on `break`; Python's `for` does not

The assistant is an async generator, and its `finally` block is what books the
tokens an abandoned stream already spent. Two tests exist to prove that: consume
one token, walk away, check the row was billed.

Written the way the Python tests are written — loop, `break`, then close — they
both passed, and one of them passed for entirely the wrong reason. Breaking out of
a `for await ... of` loop calls `return()` on the iterator automatically, so the
generator was closed and billed at the `break`. The later line that meant to close
it was a no-op, and the test that installs a priced estimate *after* the break was
installing it after the only call that would have used it. It asserted a spend of
0.25 and got 0.

Both tests now hold the iterator and call `next()` by hand. The lesson generalises
past these two: any test that wants to control *when* a generator closes cannot
use `for await ... of` to read from it.

## 11. A rebase to reword a commit deleted the commit

Backticks in a `git commit -m "..."` string are shell-executed, so
``rather than `as number` on`` became `rather than  on` and two words were eaten
by `clang`. Reaching for `git rebase --onto <parent> <commit> HEAD` to fix the
message dropped the commit's *contents* as well, leaving a detached HEAD and a
working tree missing a whole refactor.

Recovered with `git reset --hard <the pre-rebase sha>`, which was only possible
because the sha was still in the terminal scrollback.

**Next time:** commit messages with any punctuation go through `git commit -F
file`, and rewording is `git commit --amend`, never `rebase --onto`.
