/** A message the user should see, without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

/** Thrown when a command needs credentials and none are on disk. */
export class NotLoggedInError extends CliError {
  constructor() {
    super("Not logged in.", { exitCode: 2, hint: "Run `aiand login` first." });
    this.name = "NotLoggedInError";
  }
}

/** A non-2xx response from the API, with the server's message unwrapped. */
export class ApiError extends CliError {
  readonly status: number;
  readonly requestId?: string;
  readonly type?: string;

  constructor(
    status: number,
    message: string,
    opts: { requestId?: string; type?: string; hint?: string } = {}
  ) {
    super(message, { exitCode: 1, hint: opts.hint });
    this.name = "ApiError";
    this.status = status;
    this.requestId = opts.requestId;
    this.type = opts.type;
  }
}
