// Shared JavaScript source embedded in Node harness tools. Installed tools run
// standalone, so each rendered tool carries its own copy. The source avoids
// backticks and "${" so it can be embedded in template literals unchanged.

export function renderNodeToolHeader(description: string): string {
  return `#!/usr/bin/env node
"use strict";
// ${description}
`;
}

// parseToolArguments(argv, spec) mirrors the argparse behavior the tools rely on:
// long options as "--name value" or "--name=value", required options, choices,
// repeatable options, flags, positionals, and usage errors that exit with 2.
export const NODE_TOOL_ARGUMENT_PARSER = String.raw`
function parseToolArguments(argv, spec) {
  const prog = require("node:path").basename(process.argv[1] || "tool");
  const options = spec.options || {};
  const positionals = spec.positionals || [];
  const usage = "usage: " + prog
    + Object.keys(options).map((name) => " [" + name + (options[name].flag ? "" : " " + name.slice(2).toUpperCase()) + "]").join("")
    + positionals.map((name) => " " + name).join("");
  const fail = (message) => {
    process.stderr.write(usage + "\n" + prog + ": error: " + message + "\n");
    process.exit(2);
  };
  const values = {};
  for (const [name, option] of Object.entries(options)) {
    values[option.dest] = option.append ? [] : option.flag ? false : option.default;
  }
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(usage + "\n\n" + (spec.description || "") + "\n");
      process.exit(0);
    }
    if (!argument.startsWith("--") || argument === "--") {
      remaining.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator >= 0 ? argument.slice(0, separator) : argument;
    const option = options[name];
    if (!option) {
      fail("unrecognized arguments: " + argument);
    }
    if (option.flag) {
      values[option.dest] = true;
      continue;
    }
    let value;
    if (separator >= 0) {
      value = argument.slice(separator + 1);
    } else {
      if (index + 1 >= argv.length) {
        fail("argument " + name + ": expected one argument");
      }
      index += 1;
      value = argv[index];
    }
    if (option.choices && !option.choices.includes(value)) {
      fail("argument " + name + ": invalid choice: '" + value + "' (choose from " + option.choices.map((choice) => "'" + choice + "'").join(", ") + ")");
    }
    if (option.append) {
      values[option.dest].push(value);
    } else {
      values[option.dest] = value;
    }
  }
  if (remaining.length > positionals.length) {
    fail("unrecognized arguments: " + remaining.slice(positionals.length).join(" "));
  }
  positionals.forEach((name, index) => {
    values[name] = remaining[index];
  });
  const missing = [
    ...positionals.filter((name) => values[name] === undefined),
    ...Object.entries(options).filter(([, option]) => option.required && values[option.dest] === undefined).map(([name]) => name)
  ];
  if (missing.length > 0) {
    fail("the following arguments are required: " + missing.join(", "));
  }
  return values;
}
`;

// postJson(url, body, timeoutMs) returns { ok, status, statusText, text } or
// throws on network failure or timeout, like urllib.request.urlopen.
export const NODE_TOOL_HTTP = String.raw`
async function postJson(url, body, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { ok: response.ok, status: response.status, statusText: response.statusText, text: await response.text() };
}

function networkErrorText(error) {
  const cause = error && error.cause;
  return (cause && (cause.message || cause.code)) || (error && error.message) || String(error);
}
`;
