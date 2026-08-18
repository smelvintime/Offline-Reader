---
name: phased-fleet
description: Run a substantial piece of development as a phased fleet of subagents — a mapping round, a written plan carrying an explicit decisions register, dependency-ordered build rounds with parallel agents on disjoint files, an adversarial checker round, and a verify-and-ship round. Use this whenever the work is bigger than one sitting: a new feature area, a refactor spanning many files, a migration, an audit, or a phased plan someone wants executed. Reach for it as soon as the user says "the whole thing", "thoroughly", "a team of agents", "phases", "rounds", or asks to resume a multi-phase plan already written down — and also when they describe a large piece of work without naming a process, since the default of one agent editing files serially is what this exists to replace.
---

# Phased fleet

A way to run large work as rounds of subagents instead of one long serial slog.

The value is not parallelism. Parallelism is a side effect. The value is that
**each round produces something the next round can be checked against** — a map,
then a plan, then an implementation, then findings, then a verified ship. Work
that would otherwise drift for hours gets a gate every couple of rounds.

## When this earns its keep, and when it doesn't

Worth it when the work has genuine internal structure: several features that
touch different files, a plan with phases someone already wrote, a refactor with
a dependency order, an audit that wants many independent lenses.

Skip it for a single-file change, a bug with one obvious cause, or anything you
could finish in a few tool calls. A fleet has real overhead — briefing agents,
reconciling their returns, resolving contradictions — and on small work that
overhead is the whole cost with none of the benefit. Reading three agent reports
about a two-line fix is worse than just making the fix.

The honest test: *would I need to keep notes to avoid losing track?* If yes,
rounds help. If no, just do the work.

## The shape

| Round | Who | Produces |
|---|---|---|
| **Map** | 2–5 readers, parallel | How the code actually works today |
| **Plan** | 1 planner | Phased plan, decisions register, contracts |
| **Build 1..N** | implementers, parallel within a round | The change |
| **Check** | 3–5 checkers, then fixers | Findings, then fixes |
| **Ship** | verifier + scribe | Green tests, updated docs, a PR |

Build rounds are ordered by dependency, not by topic. Everything inside one
round must be able to run at the same time without collision. That constraint is
what decides the round boundaries — not tidiness, not feature grouping.

## Round 0 — Map

Send several readers at the areas the work will touch, one area each, in one
message so they run together. Ask each for the same thing: how this part works,
what its contracts are, what surprised them, what would break if it changed.

Read the map yourself before planning. This round exists because a plan written
against an imagined codebase produces build rounds that spend their time
discovering the plan was wrong. An hour of mapping saves an afternoon of that.

If you already know the codebase well, say so and skip this round. Mapping code
you understand is theatre.

## Round 1 — Plan

One planner, not a fleet. Plans written by committee contradict themselves.

The plan needs three things beyond the obvious list of work:

**Phases with dependency order.** What must exist before what. This is what
determines the build rounds.

**A decisions register.** Every question the work raises that only the user can
truly answer — product judgment, taste, risk appetite, anything with a business
consequence. Write them down with the assumption you're proceeding on. You are
going to make these calls to keep moving, and that's correct; what's not correct
is making them silently. The register is how the user finds out what you decided
on their behalf, in one place, instead of discovering it in a diff three weeks
later.

**Contracts that must not break.** The invariants the build rounds could
plausibly violate — a promise in the README, a security boundary, a public
interface, a performance budget. Name them explicitly, because the checker round
can only verify contracts it has been told about, and an unnamed invariant is
one nobody checks.

Show the plan to the user before building. This is the cheapest possible moment
to be wrong.

## Rounds 2..N — Build

Parallel agents within a round, rounds in sequence.

**The one rule that makes this safe: disjoint file ownership.** Two agents in the
same round must never write the same file. Not "probably won't" — must not. When
two agents edit one file concurrently, one silently loses, and the loss surfaces
much later as a change that mysteriously isn't there. If two pieces of work want
the same file, they belong in different rounds, or they're one agent's job.

Brief each implementer with:

- the goal, in terms of observable behavior rather than implementation
- **exactly which files it owns** and that it must not touch others
- the contracts from the plan that apply to it
- how to verify its own work — the test command, the check to run
- what to return: what changed, what it couldn't do, what it noticed but left alone

That last item matters more than it looks. An agent that hits something out of
scope should report it, not fix it. Scope creep inside a parallel round is how
file ownership gets violated by accident.

Between rounds, reconcile. Read what came back, run the tests yourself, resolve
contradictions before the next round builds on top of them. A round is not
finished when its agents return; it's finished when you've verified what they
produced. Skipping that reconciliation is the most common way one bad return
poisons three subsequent rounds.

## Round N+1 — Check

The round that most distinguishes this from "spawn some agents and hope".

Send checkers that did **not** write the code. Self-review by the author finds
almost nothing; the author's blind spots are exactly the ones that produced the
bug. Fresh agents reading the diff cold find real problems.

Useful lenses, roughly in order of what they catch:

- **Plan compliance** — does the diff do what the plan said? Anything quietly
  dropped, anything added nobody asked for?
- **Correctness** — bugs, edge cases, error paths. Ask for a concrete failure
  scenario per finding: inputs, and the wrong result. A finding without one is
  usually a guess.
- **Contract adherence** — check each named contract from the plan by name.
- **Consistency** — does the new code look like the code around it? Naming,
  structure, comment density, idiom. Consistency is what keeps a codebase
  readable by the next person, and fleets erode it faster than solo work because
  each agent brings its own house style.
- **Security** — for anything touching input parsing, auth, file paths,
  serialization, or network boundaries.
- **Documentation drift** — does the documentation still describe reality? Docs
  go stale silently, and a confidently wrong doc costs more than a missing one.

**Separate finding from fixing.** Checkers report; fixers apply. An agent that
can fix what it finds is motivated to find fixable things, and it stops looking
once it starts editing. Keeping them apart also gives you a moment to triage —
not every finding deserves a fix, and that call is yours.

Verify findings before acting on them. Confident, wrong findings are common. If a
finding is severe or expensive to fix, send an independent agent to try to
*refute* it. Anything that survives an honest attempt at refutation is probably
real.

## Final round — Ship

**Run the tests yourself.** Not "the agent said tests pass" — run them, read the
output. Agents report success optimistically. This is a five-second check that
catches an embarrassing category of failure.

**Check that the change actually reaches a user.** This is the step most often
skipped, and it has a specific failure mode worth internalizing: code can be
correct, reviewed, merged, and still reach nobody. A cached asset that was never
version-bumped. A feature behind a flag that stayed off. A migration that never
ran. A config the deploy doesn't read. Ask, concretely: *what does a user do, and
what do they see?* If you can't trace that path, the work isn't shipped, it's
just committed.

When you find one of these, the durable fix is usually automation rather than
diligence — a CI check that fails the build when the invariant is violated. The
next person will forget for exactly the same reason you did.

**Update the docs in the same change.** A doc that contradicts the code is worse
than no doc, because it's trusted. If the change alters how something is built,
run, or deployed, the page describing that is part of the diff.

**Report honestly.** State what's done, what's assumed, what's unverified, and
what you skipped. Surface the decisions register — every call you made on the
user's behalf, in one list, so they can overrule any of them cheaply. Work
described as complete when parts are untested is the fastest way to lose a
user's trust in every other report you make.

## Briefing an agent

The brief is the whole interface. Agents can't ask clarifying questions
mid-flight, so ambiguity becomes an invented answer.

```
Goal:        <observable outcome, not implementation>
Owns:        <exact file paths — write nothing else>
Context:     <what it needs from the map/plan; don't make it rediscover>
Contracts:   <invariants that apply here>
Verify:      <the command that proves it worked>
Return:      <what changed / what you couldn't do / what you noticed>
```

Give agents enough context to work and no more. An agent that has to re-map the
codebase before starting is wasting most of its budget on work you already did.

## Scaling

Match the fleet to the work. Three agents on a small feature; nine on a phase
with nine independent pieces. If you can't name what each agent owns, you have
too many.

Rounds are cheaper to add than agents are. A round of three, reconciled, then
another round of three beats one round of six that collide.

If a `Workflow` tool is available, it can encode this structure deterministically
— fan-out, barriers, verification stages — which is worth it for large or
repeated runs. The rounds are the same either way; the tool only changes who
holds the control flow.

## Anti-patterns

**Fleet on trivial work.** Overhead with no upside. Just do the change.

**Agents sharing files.** Silent lost writes. Reorder into separate rounds.

**Authors reviewing themselves.** Finds nothing. Fresh eyes, always.

**Skipping reconciliation between rounds.** One bad return propagates.

**Trusting reports over tests.** Run the command yourself.

**Silent assumptions.** Every call made for the user goes in the register.

**Declaring done at "merged".** Merged is not delivered. Trace the user path.
