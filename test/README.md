# Mingming tests

Run with `npm test` from the Mingming folder (Node.js 22.13 or newer; about 5 seconds).

Everything runs inside one Node process: the real Worker code (`src/index.js`), an in-memory SQLite database standing in for Cloudflare D1, and a fake Discord. Nothing contacts the real Discord or Cloudflare, no servers or ports are used, and no project files are created, changed, or deleted.

The 142 checks cover setup, registration, section switching, retired sections, Discord permission failures, staff-role protection, overlapping submissions, replayed requests, slow or unresponsive Discord, roster export and clearing, and database failures injected at specific moments (including a failed save followed by a failed cleanup).

The command exits with code 1 if any check fails.

Limits: a pretend Discord and database can't prove the real ones behave identically. Do a final trial on a real test server with a second Discord account.
