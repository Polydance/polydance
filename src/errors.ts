/** A problem the user can fix: wrong arguments, nothing connected, missing tool. Printed without a stack. */
export class UserError extends Error {
  constructor(message: string, readonly exitCode = 2) { super(message); this.name = 'UserError'; }
}
