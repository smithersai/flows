# Private alpha notes

These notes describe operational limits that alpha users and hosts must account
for. They are statements of the shipped posture, not promises of planned
behavior.

## Supervision

The agent gateway does **not** automatically recover abandoned runs in the
private alpha (audit P1-2). `@smthrs/gateway` exposes the `SuperviseRuntime`
host contract, but its only bundled defaults are `makeNoop` and `layerNoop`:
the default scan returns no candidates and the default resume performs no
work. No production gateway layer connects that contract to the durable
engine's run-driver sweep.

Consequently, a run abandoned by its gateway host is not discovered, reclaimed,
or resumed by the gateway. Operators must recover it explicitly, or use a host
composition that runs the durable engine driver with the relevant flows
registered. Do not rely on unattended gateway recovery for alpha workloads.

This limitation can be retired after a production gateway composition wires
the engine recovery path and a crash-recovery test proves that a stale owner is
reclaimed and the run makes progress automatically.
