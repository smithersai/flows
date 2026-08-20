# factory/repros/

One directory per issue, holding the proof-of-concept attempts written for it.
Presence is registration and the path is the name, the same doctrine the queue
uses.

```
factory/repros/
  42/
    attempt-1.md            the hypothesis, in prose
    attempt-1.ts            the runnable program
    attempt-1.result.json   what the sandbox observed
```

The pair shape is copied from `apps/ui/canary-repros/`, which proved it: the
markdown is what a person reads and the TypeScript is what a machine runs, and
keeping them adjacent means neither can quietly stop describing the other.

## The program

`attempt-N.ts` runs under `node <file>` with Node 22 type stripping. It:

- imports only `node:*` builtins and this repository's packages,
- exits non-zero, with a clear message, when the reported bug is present,
- exits zero when it is absent,
- writes nothing outside the system temporary directory,
- never reaches the network.

A non-zero exit is the whole verdict. Whether that counts as a reproduction is
decided elsewhere: a repro is `repro:verified` only when the program fails on
`main` **and** the reporter confirmed the pair captures their issue.

## Who writes here

`factory/automation/poc.ts` writes the pair and commits it.
`factory/automation/poc-run.ts` runs it in a job that holds no credential and
records `attempt-N.result.json`. Nothing else writes here.

## Where a repro ends up

A repro that leads to a fix moves into the affected package's test suite as a
permanent regression test. It is not deleted once it goes green. The proof gate
(`gen.repro-proof.yml`) reads this directory: a pull request whose body says
`Closes #N` must touch `factory/repros/N/`, and the program there must fail at
the merge base and pass at the head.

The directory stays after the fix lands, so the scheduled sweep
(`gen.repro-reverify.yml`) can keep re-running it against `main`.
