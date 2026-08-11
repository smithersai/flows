/**
 * Rendering of a spawned command into the line the interpreter runs.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"

/**
 * The command line handed to the interpreter.
 *
 * Without `shell`, `CommandLine.render` quotes the command and its arguments so
 * that a spawn is literal argv the way `NodeChildProcessSpawner` makes it. That
 * renderer is deliberately the *same* one `@smthrs/kernel/ChildProcessSpawner`
 * writes as the `proc:spawn` capability resource: a grant and the line a tab
 * actually runs must be the same string, or the kernel would be authorizing
 * something other than what happens.
 *
 * With `shell`, the parts are joined verbatim, mirroring how Node hands `sh -c`
 * an unquoted line.
 *
 * @private
 * @since 0.1.0
 */
export const commandLine = (command: ChildProcess.StandardCommand): string => {
  const shell = command.options.shell
  return shell === undefined || shell === false
    ? CommandLine.render(command)
    : [command.command, ...command.args].join(" ")
}
