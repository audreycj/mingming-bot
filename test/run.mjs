/**
 * Mingming tests: run with `npm test` (needs Node.js 22.13 or newer).
 *
 * Everything runs inside this one Node process: the real Worker code (src/index.js),
 * an in-memory SQLite database standing in for Cloudflare D1, and a fake Discord.
 * No servers, no network, and no files in your project are touched.
 * Failures (Discord errors, database errors, slow responses) are injected on purpose.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import worker from "../src/index.js";

// Mingming logs errors with console.error; injected failures would flood the output,
// so collect them quietly (set SHOW_LOGS=1 to see them).
const loggedErrors = [];
if (!process.env.SHOW_LOGS) console.error = (...args) => loggedErrors.push(args.join(" "));

// ---------------------------------------------------------------- fake D1
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const dbFaults = []; // regexes: matching SQL statements throw, to simulate a database outage
const DB = {
  prepare(sql) {
    const fault = () => { if (dbFaults.some((re) => re.test(sql))) throw new Error("Injected database failure"); };
    const stmt = {
      args: [],
      bind(...a) { stmt.args = a; return stmt; },
      async run() { fault(); return { meta: { changes: Number(sqlite.prepare(sql).run(...stmt.args).changes) } }; },
      async first() { fault(); return sqlite.prepare(sql).get(...stmt.args) ?? null; },
      async all() { fault(); return { results: sqlite.prepare(sql).all(...stmt.args) }; },
    };
    return stmt;
  },
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec("COMMIT"); return out; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};
const uploads = new Map(); // fake Discord attachment CDN

// ---------------------------------------------------------------- fake Discord
const discord = { members: new Map(), missing: new Set(), calls: [], failMember: false, danger: false, patchDelayMs: 0, hangMemberGet: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonRes = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  if (url.startsWith("https://cdn.test/")) return new Response(uploads.get(url) ?? "", { status: uploads.has(url) ? 200 : 404 });
  const path = url.replace("http://fake-discord", "");
  const body = typeof opts.body === "string" ? JSON.parse(opts.body) : null;
  discord.calls.push({ method: opts.method || "GET", path, auth: opts.headers?.Authorization || null, body });
  const m = path.match(/\/guilds\/\d+\/members\/(\d+)$/);
  if (m && (opts.method || "GET") === "GET") {
    if (discord.hangMemberGet) {
      // Never answers; only the request's timeout signal can end it.
      // (keepAlive stops Node from exiting while it waits; Cloudflare doesn't need this.)
      const keepAlive = setInterval(() => {}, 1000);
      return new Promise((_, reject) =>
        opts.signal?.addEventListener("abort", () => { clearInterval(keepAlive); reject(new Error("timed out")); })
      );
    }
    if (discord.missing.has(m[1])) return jsonRes(404, { message: "Unknown Member", code: 10007 });
    return jsonRes(200, { roles: discord.members.get(m[1]) || [] });
  }
  if (m && opts.method === "PATCH") {
    if (discord.patchDelayMs) await sleep(discord.patchDelayMs);
    if (discord.failMember) return jsonRes(403, { message: "Missing Permissions", code: 50013 });
    discord.members.set(m[1], body.roles);
    return jsonRes(200, {});
  }
  const gm = path.match(/^\/guilds\/(\d+)$/);
  if (gm && (opts.method || "GET") === "GET") {
    return jsonRes(200, { id: gm[1], owner_id: "9", system_channel_id: gm[1] === "333" ? null : `log-${gm[1]}` });
  }
  if (path.endsWith("/channels")) {
    const view = String(1n << 10n);
    if (discord.channelsDown) return jsonRes(500, {});
    return jsonRes(200, [
      { id: "cat-a", type: 4, name: "BSIT 2A", permission_overwrites: [{ id: "111", type: 0, allow: "0", deny: view }, { id: "601", type: 0, allow: view, deny: "0" }] },
      { id: "cat-b", type: 4, name: "BSIT 2B", permission_overwrites: [{ id: "111", type: 0, allow: "0", deny: view }, { id: "602", type: 0, allow: view, deny: "0" }] },
      { id: "ann-a", type: 0, name: "announcements", parent_id: "cat-a", position: 0 },
      { id: "gen-a", type: 0, name: "general", parent_id: "cat-a", position: 1 },
      { id: "ann-b", type: 0, name: "announcements", parent_id: "cat-b", position: 0 },
      { id: "gen-b", type: 0, name: "general", parent_id: "cat-b", position: 1 },
    ]);
  }
  if (path.endsWith("/roles")) {
    return jsonRes(200, [
      { id: "111", permissions: "0" }, { id: "500", permissions: discord.danger ? "8" : "0" },
      { id: "601", permissions: "0" }, { id: "602", permissions: "0" }, { id: "777", permissions: "0" },
    ]);
  }
  return jsonRes(200, {});
};

// ---------------------------------------------------------------- environment
const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
const env = { DISCORD_PUBLIC_KEY: publicHex, DISCORD_TOKEN: "test-token", DISCORD_APPLICATION_ID: "app123", DISCORD_API_BASE: "http://fake-discord", DB };
let background = [];
const ctx = { waitUntil: (p) => background.push(p) };
const settle = async () => { while (background.length) { const b = background; background = []; await Promise.all(b); } };

// ---------------------------------------------------------------- helpers
const G = "111", ADMIN_PERMS = String(1n << 5n), STUDENT = "500", SEC_A = "601", SEC_B = "602";
let pass = 0, fail = 0, tok = 0;
async function send(payload, { badSig = false, ageSeconds = 0 } = {}) {
  const body = JSON.stringify({ token: `tok${++tok}`, application_id: "app123", ...payload });
  const ts = String(Math.floor(Date.now() / 1000) - ageSeconds);
  let sig = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body))).toString("hex");
  if (badSig) sig = sig.replace(/^./, (c) => (c === "a" ? "b" : "a"));
  const req = new Request("https://mingming.test/", { method: "POST", headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts }, body });
  const res = await worker.fetch(req, env, ctx);
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, ct, token: JSON.parse(body).token, data: ct.includes("json") ? await res.json() : await res.text() };
}
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`); };
const admin = () => ({ user: { id: "9", username: "audrey" }, roles: [], permissions: ADMIN_PERMS });
const adminNamed = () => ({ user: { id: "9", username: "acj.nanual", global_name: "Audrey Nanual" }, nick: null, roles: [], permissions: ADMIN_PERMS });
const student = (id, roles = []) => ({ user: { id, username: "stud" + id }, roles, permissions: "0" });
const cmd = (name, options = [], resolved) => ({ type: 2, guild_id: G, channel_id: "c1", member: admin(), data: { name, options, resolved } });
const followUp = (token) => discord.calls.filter((x) => x.path.includes(`/webhooks/app123/${token}/`)).at(-1)?.body?.content || "";
const patches = (uid) => discord.calls.filter((x) => x.method === "PATCH" && x.path === `/guilds/${G}/members/${uid}`);
const panels = () => discord.calls.filter((x) => x.path === "/channels/c1/messages");
const form = (uid, sec, f, l, e, middle = "", suffix = "") => ({ type: 5, guild_id: G, member: student(uid), data: { custom_id: `regform:${sec}`, components: [["first", f], ["middle", middle], ["last", l], ["suffix", suffix], ["email", e]].map(([id, v]) => ({ type: 1, components: [{ type: 4, custom_id: id, value: v }] })) } });
const submit = async (...args) => { const r = await send(form(...args)); await settle(); return r; };
const clickBtn = (uid, roles, customId) => send({ type: 3, guild_id: G, member: student(uid, roles), data: { custom_id: customId } });
const role = (id, name, permissions = "0") => ({ roles: { [id]: { name, permissions } } });
const exportCsv = async () => (await send(cmd("export-roster"))).data;

// ================================================================ TESTS
console.log("\n▸ Security");
let r = await send({ type: 1 }, { badSig: true });
check("Forged request rejected", r.status === 401);
r = await send({ type: 1 }, { ageSeconds: 600 });
check("Replayed (10-minute-old) request rejected", r.status === 401);
r = await send({ type: 1 });
check("Discord PING answered", r.data.type === 1);
r = await send({ ...cmd("settings"), member: student("20") });
check("Student can't use instructor commands", r.data.data.content.includes("Only instructors"));

console.log("\n▸ Setup");
r = await send(cmd("post-register"));
check("Post before setup is blocked", r.data.data.content.includes("/setup"));
r = await send(cmd("setup", [{ name: "course_name", value: "DSA" }, { name: "student_role", value: G }], role(G, "@everyone")));
check("@everyone rejected as Student role", r.data.data.content.includes("can't be used"));
r = await send(cmd("setup", [{ name: "course_name", value: "DSA" }, { name: "student_role", value: "888" }], role("888", "Mods", String(1n << 3n))));
check("Admin role rejected as Student role", r.data.data.content.includes("staff powers"));
r = await send(cmd("setup", [{ name: "course_name", value: "DSA" }, { name: "student_role", value: "889" }], role("889", "Helpers", String(1n << 28n))));
check("Manage Roles role rejected", r.data.data.content.includes("staff powers"));
r = await send(cmd("setup", [{ name: "course_name", value: "Data Structures and Algorithms" }, { name: "student_role", value: STUDENT }], role(STUDENT, "Student")));
check("/setup works", r.data.data.content.includes("Course set to"));

console.log("\n▸ One-class server");
r = await send(cmd("post-register"));
check("/post-register replies 'thinking' first (3-second rule)", r.data.type === 5);
await settle();
let post = panels().at(-1);
check("No sections → single Register button", post.body.components[0].components.length === 1 && post.body.components[0].components[0].custom_id === "reg:none");
check("Instructor told panel was posted", followUp(r.token).includes("posted"));
check("[Contact] Panel tells students to message their instructor, with a tappable mention", post.body.embeds[1].description.includes("Message your instructor, <@9>.") && !post.body.embeds[1].description.includes("**audrey**"), post.body.embeds[1].description.split("\n").at(-1));
check("Panel privacy wording (single instructor)", post.body.embeds[1].description.includes("Only your instructor can download your email") && !post.body.embeds[1].description.includes("instructor(s)"));
check("[Panel] Two boxes: steps (orange) and important rules (yellow); name rule moved to the form", post.body.embeds.length === 2 && post.body.embeds[1].color === 0xfacc15 && post.body.embeds[1].description.startsWith("### 📧 Use an email you actually check") && !JSON.stringify(post.body).includes("school records"));
check("[Panel] No cat sounds in the panel", !JSON.stringify(post.body).match(/Meow|Mrrp|Hiss/));
check("Panel uses headings for the title and steps", /^## 🐾 Welcome to /.test(post.body.embeds[0].description) && post.body.embeds[0].description.includes("### 1️⃣") && post.body.embeds[0].description.includes("### 2️⃣"));

r = await clickBtn("21", [], "reg:none");
check("Register button opens form", r.data.type === 9 && r.data.data.components.length === 5);
const formFields = r.data.data.components.map((row) => row.components[0]);
check("[Names] Form: First, Middle (optional), Last, Suffix (optional), Email; no confirm-email", formFields.map((f) => f.custom_id).join(",") === "first,middle,last,suffix,email" && !formFields[1].required && !formFields[3].required && formFields[0].required && formFields[2].required && formFields[4].required);
check("[Names] First Name asks for the complete name, with a nickname example (labels fit Discord's 45-character limit)", formFields[0].label === "Complete First Name" && formFields[0].placeholder === "e.g., Juan Miguel (not Migs or JM)" && formFields[2].label === "Last Name" && !JSON.stringify(formFields).includes("school records") && formFields.every((f) => f.label.length <= 45));
check("All form labels within 45 chars", r.data.data.components.every((row) => row.components[0].label.length <= 45));
r = await send(form("21", "none", "xX_gamer", "Xx", "a@b.com"));
check("Fake name rejected", r.data.data?.content?.includes("real name"));
r = await send(form("21", "none", "Juan", "Dela Cruz", "juan@gmail"));
check("Bad email rejected", r.data.data?.content?.includes("doesn't look right"));
check("Retry message names the Register button (single-button panel)", r.data.data?.content?.includes("Click **Register** to try again") && !r.data.data?.content?.includes("the button"));
r = await send(form("21", "list", "Juan", "Dela Cruz", "juan@gmail"));
check("Retry message names the Register button (class-list panel)", r.data.data?.content?.includes("Click **Register** to try again"));
r = await send(form("21", "999", "Juan", "Dela Cruz", "juan@gmail"));
check("Retry message points to the section's button (section-buttons panel)", r.data.data?.content?.includes("Click **your section's button** to try again"));
r = await send(form("21", "none", "Juan", "Dela Cruz", "juan@gmail.com", "S4ntos"));
check("[Names] Invalid middle name rejected", r.data.data?.content?.includes("real name"));
r = await send(form("21", "none", "Juan", "Dela Cruz", "juan@gmail.com", "", "Jnr"));
check("[Names] Unrecognized suffix rejected", r.data.data?.content?.includes("Jr., Sr., II, III, or IV"));

discord.members.set("21", ["777"]);
r = await send(form("21", "none", "  JUAN miguel ", "dela cruz", "Juan.DelaCruz@Gmail.com "));
check("Valid form gets 'thinking' reply", r.data.type === 5 && r.data.data.flags === 64);
await settle();
let p = patches("21").at(-1);
check("Nickname + Student role in ONE request, unrelated role kept", p?.body.nick === "Juan Miguel Dela Cruz" && p.body.roles.includes(STUDENT) && p.body.roles.includes("777"), JSON.stringify(p?.body));
check("Student gets confirmation with email", followUp(r.token).includes("juan.delacruz@gmail.com"));
check("[General link] One-class server: confirmation links the server's #general", followUp(r.token).includes("<#gen-a>"));
r = await clickBtn("21", ["777", STUDENT], "reg:none");
check("Already-registered student blocked", r.data.data.content.includes("already registered"));

console.log("\n▸ Sections");
r = await send(cmd("add-section", [{ name: "role", value: STUDENT }], role(STUDENT, "Student")));
check("Student role can't be a section", r.data.data.content.includes("That's your Student role"));
r = await send(cmd("add-section", [{ name: "role", value: SEC_A }], role(SEC_A, "BSIT 2A")));
check("/add-section BSIT 2A", r.data.data.content.includes("Added section 🐾 **BSIT 2A**"));
r = await send(cmd("add-section", [{ name: "role", value: SEC_B }, { name: "label", value: "   " }], role(SEC_B, "BSIT 2B")));
check("Blank label falls back to role name", r.data.data.content.includes("**BSIT 2B**"));
r = await send(cmd("setup", [{ name: "course_name", value: "DSA" }, { name: "student_role", value: SEC_A }], role(SEC_A, "BSIT 2A")));
check("A section role can't become the Student role", r.data.data.content.includes("one of your sections"));
r = await clickBtn("22", [], "reg:none");
check("Old no-section panel button → out of date", r.data.data.content.includes("out of date"));
r = await submit("26", "none", "Lea", "Cruz", "lea@gmail.com");
check("Already-open no-section form rejected after sections added", followUp(r.token).includes("out of date") && patches("26").length === 0);
r = await send(cmd("post-register"));
await settle();
check("New panel: one button per section", panels().at(-1).body.components[0].components.map((b) => b.label).join(",") === "BSIT 2A,BSIT 2B");
check("[Panel] Section panel warns to choose the section carefully (in the yellow box)", panels().at(-1).body.embeds[1].description.includes("### ⚠️ Choose your section carefully"));
check("[Contact] Section panel tells students to message the instructor", panels().at(-1).body.embeds[1].description.includes("Message your instructor, <@9>."));
r = await clickBtn("22", [], `reg:${SEC_B}`);
check("Section form title", r.data.data.title === "🐾 Register for BSIT 2B");
r = await send(cmd("add-section", [{ name: "role", value: SEC_A }, { name: "emoji", value: "yellow" }], role(SEC_A, "BSIT 2A")));
check("[Colors] Non-emoji rejected", r.data.data.content.includes("single emoji"));
r = await send(cmd("add-section", [{ name: "role", value: SEC_A }, { name: "emoji", value: "🟡🔵" }], role(SEC_A, "BSIT 2A")));
check("[Colors] Two emojis rejected", r.data.data.content.includes("single emoji"));
r = await send(cmd("add-section", [{ name: "role", value: SEC_A }, { name: "emoji", value: "🟡" }], role(SEC_A, "BSIT 2A")));
check("[Colors] /add-section with 🟡 accepted", r.data.data.content.includes("🟡 **BSIT 2A**"));
r = await send(cmd("add-section", [{ name: "role", value: SEC_A }], role(SEC_A, "BSIT 2A")));
check("[Colors] Re-running without emoji keeps 🟡", r.data.data.content.includes("🟡 **BSIT 2A**"));
r = await send(cmd("post-register"));
await settle();
const btns = panels().at(-1).body.components[0].components;
check("[Colors] Buttons show their own emoji (🟡 BSIT 2A, default 🐾 BSIT 2B)", btns[0].emoji.name === "🟡" && btns[0].label === "BSIT 2A" && btns[1].emoji.name === "🐾", btns.map((b) => b.emoji.name + " " + b.label).join(", "));
r = await clickBtn("22", [], `reg:${SEC_A}`);
check("[Colors] Form title uses the section emoji", r.data.data.title === "🟡 Register for BSIT 2A");
r = await send(cmd("settings"));
check("[Colors] /settings lists emojis", r.data.data.content.includes("• 🟡 **BSIT 2A**"));

await send(cmd("setup", [{ name: "course_name", value: "Data Structures and Algorithms" }, { name: "student_role", value: STUDENT }, { name: "name_format", value: "last_first" }], role(STUDENT, "Student")));
discord.members.set("22", ["777"]);
r = await submit("22", SEC_B, "Ma. Cristina", "PEÑA", "cris@dorsu.edu.ph");
check("[General link] Section student gets a clickable link to THEIR section's #general", followUp(r.token).includes("<#gen-b>") && !followUp(r.token).includes("<#gen-a>"));
p = patches("22").at(-1);
check("Section + Student roles, 'Last, First' nickname", p?.body.nick === "Peña, Ma. Cristina" && p.body.roles.includes(SEC_B) && p.body.roles.includes(STUDENT));
r = await submit("27", SEC_A, "liam", "o’neil", "liam@gmail.com");
check("[General link] BSIT 2A student gets BSIT 2A's #general", followUp(r.token).includes("<#gen-a>"));
discord.channelsDown = true;
r = await submit("35", SEC_A, "Mia", "Lopez", "mia@example.com");
discord.channelsDown = false;
check("[General link] If channels can't be read, registration still succeeds (just no link)", followUp(r.token).includes("You're registered") && !followUp(r.token).includes("<#"));
check("Curly apostrophe (phone keyboard) accepted", patches("27").at(-1)?.body.nick === "O'Neil, Liam", patches("27").at(-1)?.body.nick);
await submit("29", SEC_A, "Ana", "O", "ana.o@gmail.com");
discord.members.set("33", []);
await submit("33", SEC_A, "jose", "dela rosa", "jose@gmail.com", "santos", "jr");
check("[Names] Middle initial + suffix in nickname (Last, First: PH records style)", patches("33").at(-1)?.body.nick === "Dela Rosa, Jose Jr. S.", patches("33").at(-1)?.body.nick);
discord.members.set("34", []);
r = await submit("34", SEC_A, "Ana Isabella Rosalie Victoria", "Valle", "ana@example.com", "Bernardo");
check("[Long names] Extra given names become initials, middle initial kept last", patches("34").at(-1)?.body.nick === "Valle, Ana Isabella R. V. B.", patches("34").at(-1)?.body.nick);
check("[Long names] Student is told it was shortened and the full name is saved", followUp(r.token).includes("shortened to fit"));
check("[Long names] CSV keeps the full given names", (await exportCsv()).includes('"Valle","Ana Isabella Rosalie Victoria","Bernardo"'));
const { buildNickname } = await import("../src/index.js");
const ex1 = buildNickname("first_last", { first: "Ana Isabella Rosalie Victoria", middle: "Bernardo", last: "Valle", suffix: "" });
check("[Long names] First Last format keeps as many full names as fit (exactly 32 here)", ex1.nick === "Ana Isabella Rosalie V. B. Valle" && ex1.nick.length === 32 && ex1.shortened, ex1.nick);
const ex2 = buildNickname("last_first", { first: "Maria Concepcion", middle: "Santos", last: "Dela Cruz-Villaluz-Ramos", suffix: "III" });
check("[Long names] Long surname: falls back to first initial, keeps suffix, fits 32", ex2.nick === "Dela Cruz-Villaluz-Ramos, M. III" && ex2.nick.length <= 32, ex2.nick);
const ex2b = buildNickname("last_first", { first: "Maria", middle: "", last: "Dela Cruz-Villaluz-Macapagal-Ramos", suffix: "" });
check("[Long names] Impossible fit: last-resort cut ends with … and is 32 or fewer", ex2b.nick.endsWith("…") && ex2b.nick.length <= 32, ex2b.nick);
const ex3 = buildNickname("last_first", { first: "Juan", middle: "Santos", last: "Dela Cruz", suffix: "III" });
check("[Long names] Short names are untouched and not flagged", ex3.nick === "Dela Cruz, Juan III S." && !ex3.shortened);
const { tidyName } = await import("../src/index.js");
const caseCases = [
  ["JUAN MIGUEL", "Juan Miguel"], ["juan miguel", "Juan Miguel"], ["jUaN mIgUeL", "Juan Miguel"],
  ["dELA cRUZ", "Dela Cruz"], ["JuAN", "Juan"], ["PEÑA", "Peña"], ["ma. CRISTINA", "Ma. Cristina"],
  ["o'NEIL", "O'Neil"], ["o’neil", "O'Neil"], ["santos-REYES", "Santos-Reyes"],
  ["McArthur", "McArthur"], ["MacDonald", "MacDonald"], ["DeLeon", "DeLeon"], ["MCARTHUR", "Mcarthur"],
];
const caseFails = caseCases.filter(([inp, want]) => tidyName(inp) !== want).map(([inp, want]) => `${inp} -> ${tidyName(inp)} (want ${want})`);
check(`[Capitalization] ALL CAPS, lowercase, and mixed-up case all normalized (${caseCases.length} cases)`, caseFails.length === 0, caseFails.join("; "));
discord.members.set("36", []);
r = await submit("36", SEC_A, "mArIa cLaRa", "dELA rOSA", "mc@example.com", "sAnToS");
check("[Capitalization] Messy registration produces a clean nickname", patches("36").at(-1)?.body.nick === "Dela Rosa, Maria Clara S.", patches("36").at(-1)?.body.nick);
check("One-letter surname accepted", patches("29").at(-1)?.body.nick === "O, Ana");

console.log("\n▸ Re-registration and corrections");
discord.members.set("22", ["777", SEC_B]); // instructor removed Student role
await submit("22", SEC_A, "Ma. Cristina", "Peña", "cris.new@dorsu.edu.ph");
p = patches("22").at(-1);
check("Switching sections removes old section role", p.body.roles.includes(SEC_A) && !p.body.roles.includes(SEC_B) && p.body.roles.includes("777"), JSON.stringify(p.body.roles));

await send(cmd("remove-section", [{ name: "role", value: SEC_A }]));
await send(cmd("add-section", [{ name: "role", value: SEC_B }], role(SEC_B, "BSIT 2B")));
discord.members.set("22", ["777", SEC_A]);
await submit("22", SEC_B, "Ma. Cristina", "Peña", "cris.new@dorsu.edu.ph");
p = patches("22").at(-1);
check("Retired section's role removed on re-registration", p.body.roles.includes(SEC_B) && !p.body.roles.includes(SEC_A), JSON.stringify(p.body.roles));

discord.failMember = true;
discord.members.set("22", ["777", SEC_B]);
r = await submit("22", SEC_B, "Wrong", "Person", "wrong@gmail.com");
discord.failMember = false;
check("Discord permission failure explained to student", followUp(r.token).includes("move my role above"));
let csv = await exportCsv();
check("Failed re-registration kept old entry intact", csv.includes("cris.new@dorsu.edu.ph") && !csv.includes("wrong@gmail.com"));

discord.danger = true;
r = await submit("24", SEC_B, "Ana", "Reyes", "ana@gmail.com");
discord.danger = false;
check("Refused if a role later gains staff powers", followUp(r.token).includes("staff permissions") && patches("24").length === 0);

console.log("\n▸ Database failures after a successful Discord update (injected)");
// (a) Save fails but cleanup works: student is told to retry, and retrying works
discord.members.set("30", []);
dbFaults.push(/^\s*INSERT INTO students/);
r = await submit("30", SEC_B, "Rico", "Bautista", "rico@gmail.com");
dbFaults.length = 0;
check("Save failure: student has access and is told to click again", followUp(r.token).includes("click your section's button again") && discord.members.get("30").includes(STUDENT));
r = await clickBtn("30", discord.members.get("30"), `reg:${SEC_B}`);
check("Save failure: clicking again opens the form (not 'already registered')", r.data.type === 9);
r = await submit("30", SEC_B, "Rico", "Bautista", "rico@gmail.com");
check("Save failure: retry completes and saves the roster entry", followUp(r.token).includes("You're registered") && (await exportCsv()).includes("rico@gmail.com"));

// (b) ChatGPT's reproduction: existing entry + correction + save fails + cleanup ALSO fails
discord.members.set("22", ["777", SEC_B]); // instructor removed Student for a correction
dbFaults.push(/^\s*INSERT INTO students/, /^DELETE FROM students WHERE guild_id = \?1 AND user_id/);
r = await submit("22", SEC_B, "Maria Cristina", "Peña", "cris.fixed@dorsu.edu.ph");
dbFaults.length = 0;
check("Save AND cleanup fail: student told to ask instructor (not a retry that wouldn't work)", followUp(r.token).includes("ask your instructor to remove your **Student** role"), followUp(r.token).split(". ").at(-1));
discord.members.set("22", discord.members.get("22").filter((id) => id !== STUDENT)); // instructor follows the advice
r = await submit("22", SEC_B, "Maria Cristina", "Peña", "cris.fixed@dorsu.edu.ph");
csv = await exportCsv();
check("Save AND cleanup fail: after instructor removes Student, correction saves", csv.includes("cris.fixed@dorsu.edu.ph") && !csv.includes("cris.new@dorsu.edu.ph"));

// (c) Database down before anything happens: nothing changes in Discord
dbFaults.push(/in_progress/);
const before = patches("31").length;
r = await submit("31", SEC_B, "Nina", "Lopez", "nina@gmail.com");
dbFaults.length = 0;
check("Database down at start: no Discord changes, student told to retry", patches("31").length === before && followUp(r.token).includes("try registering again"));

console.log("\n▸ Overlapping submissions and time limits");
discord.patchDelayMs = 300;
discord.members.set("28", []);
const [r1, r2] = await Promise.all([send(form("28", SEC_B, "Pedro", "Santos", "pedro.phone@gmail.com")), send(form("28", SEC_B, "Pedro", "Santos", "pedro.laptop@gmail.com"))]);
await settle();
discord.patchDelayMs = 0;
const msgs = [followUp(r1.token), followUp(r2.token)];
check("Overlapping submissions: only ONE Discord update", patches("28").length === 1, `${patches("28").length} update(s)`);
check("Second submission told to wait", msgs.some((m) => m.includes("already working")) && msgs.some((m) => m.includes("You're registered")));
const winner = msgs[0].includes("You're registered") ? "pedro.phone" : "pedro.laptop";
csv = await exportCsv();
check("Roster matches the submission Discord applied", csv.includes(winner) && !csv.includes(winner === "pedro.phone" ? "pedro.laptop" : "pedro.phone"), winner);

env.REGISTRATION_BUDGET_MS = 1500; // shortened so the test is quick (real budget: 20 s)
discord.hangMemberGet = true;
const t0 = Date.now();
r = await submit("32", SEC_B, "Tess", "Garcia", "tess@gmail.com");
const took = Date.now() - t0;
discord.hangMemberGet = false;
delete env.REGISTRATION_BUDGET_MS;
check("Discord never answers: registration stops within its time budget", took < 3000 && followUp(r.token).includes("too slow"), `${took} ms`);
r = await submit("32", SEC_B, "Tess", "Garcia", "tess@gmail.com");
check("…and the lock was released, so retrying works", followUp(r.token).includes("You're registered"));

console.log("\n▸ /reset-student");
discord.members.set("27", [...discord.members.get("27"), "777"]);
r = await send({ ...cmd("reset-student", [{ name: "student", value: "27" }]), member: student("20") });
check("Students can't use /reset-student", r.data.data.content.includes("Only instructors"));
r = await send(cmd("reset-student", [{ name: "student", value: "27" }]));
check("/reset-student replies 'thinking' first", r.data.type === 5);
await settle();
p = patches("27").at(-1);
check("Reset removes Student + section roles, keeps others, clears nickname", p.body.nick === null && !p.body.roles.includes(STUDENT) && !p.body.roles.includes(SEC_A) && !p.body.roles.includes(SEC_B) && p.body.roles.includes("777"), JSON.stringify(p.body));
check("Reset deletes the saved entry", !(await exportCsv()).includes("liam@gmail.com") && followUp(r.token).includes("Reset <@27>"));
r = await clickBtn("27", discord.members.get("27"), `reg:${SEC_B}`);
check("Reset student can register again from scratch", r.data.type === 9);
discord.missing.add("99");
r = await send(cmd("reset-student", [{ name: "student", value: "99" }]));
await settle();
check("Reset for someone not in the server explains there's nothing to reset", followUp(r.token).includes("isn't in this server"));
r = await send(cmd("reset-student", [{ name: "student", value: "9" }]));
await settle();
check("Instructor can't reset themself", followUp(r.token).includes("can't reset yourself"));

console.log("\n▸ Remove section, settings, export, clear");
r = await send(cmd("remove-section", [{ name: "role", value: SEC_B }]));
check("/remove-section", r.data.data.content.includes("Removed"));
r = await clickBtn("25", [], `reg:${SEC_B}`);
check("Removed section's button no longer works", r.data.data.content.includes("out of date"));
r = await send(cmd("settings"));
check("/settings shows registered count", r.data.data.content.includes("**Registered students:** 10"), r.data.data.content.split("\n").find((l) => l.includes("Registered")));
r = await send(cmd("export-roster"));
check("/export-roster returns a CSV file", r.ct.includes("multipart/form-data") && r.data.includes("Peña"));
check("[Names] CSV has Middle Name and Suffix columns with full middle name", r.data.includes('"Last Name","First Name","Middle Name","Suffix"') && r.data.includes('"Dela Rosa","Jose","Santos","Jr."'));
check("CSV blocks spreadsheet formulas", (await import("../src/index.js")).csvCell("=HYPERLINK(1)") === `"'=HYPERLINK(1)"`);
r = await send(cmd("clear-roster", [{ name: "confirm", value: "yes" }]));
check("/clear-roster needs typed DELETE", r.data.data.content.includes("Nothing was deleted"));
r = await send(cmd("clear-roster", [{ name: "confirm", value: "DELETE" }]));
check("/clear-roster DELETE erases saved list", r.data.data.content.includes("Deleted **10**"));
r = await clickBtn("21", ["777", STUDENT], "reg:none");
check("After clearing, a student with the Student role can register again", r.data.type === 9);

console.log("\n▸ Class list (second server, made-up names)");
const G2 = "222";
const patches2 = (uid) => discord.calls.filter((x) => x.method === "PATCH" && x.path === `/guilds/${G2}/members/${uid}`);
const cmd2 = (name, options = [], resolved) => ({ type: 2, guild_id: G2, channel_id: "c2", member: admin(), data: { name, options, resolved } });
const form2 = (uid, sec, f, l, e, middle = "", suffix = "") => ({ type: 5, guild_id: G2, member: student(uid), data: { custom_id: `regform:${sec}`, components: [["first", f], ["middle", middle], ["last", l], ["suffix", suffix], ["email", e]].map(([id, v]) => ({ type: 1, components: [{ type: 4, custom_id: id, value: v }] })) } });
const submit2 = async (...a) => { const r = await send(form2(...a)); await settle(); return r; };
const attach = (name, csv) => { const url = `https://cdn.test/${name}`; uploads.set(url, csv); return [[{ name: "file", value: name }], { attachments: { [name]: { id: name, filename: name, size: csv.length, url } } }]; };
const LIST = "\uFEFFID No.,Last Name,First Name,M.I.,Ext.,Section\r\n" +
  "2025-0001,DELA CRUZ,JUAN MIGUEL,S.,,IT2C\r\n2025-0002,PEÑA,MARIA CLARA,B.,,IT2E\r\n" +
  "2025-0003,SANTOS,JOSE,R.,JR.,IT2E\r\n2025-0004,REYES,ANA,,,IT2C\r\n2025-0005,VILLANUEVA,CHRISTOPER,D.,,IT2C\r\n";

await send(cmd2("setup", [{ name: "course_name", value: "ITC 120: Data Structures and Algorithms" }, { name: "student_role", value: STUDENT }, { name: "name_format", value: "last_first" }], role(STUDENT, "Student")));
await send(cmd2("add-section", [{ name: "role", value: SEC_A }, { name: "label", value: "BSIT 2C" }, { name: "emoji", value: "🔵" }], role(SEC_A, "BSIT 2C")));
await send(cmd2("add-section", [{ name: "role", value: SEC_B }, { name: "label", value: "BSIT 2E" }, { name: "emoji", value: "🟣" }], role(SEC_B, "BSIT 2E")));
r = await send(cmd2("retire-role", [{ name: "role", value: "901" }], role("901", "2E (unregistered)")));
check("[Class list] /retire-role marks an old role for automatic removal", r.data.data.content.includes("removed automatically"));
r = await send(cmd2("retire-role", [{ name: "role", value: STUDENT }], role(STUDENT, "Student")));
check("[Class list] The Student role can't be retired", r.data.data.content.includes("can't be retired"));

let [o, res] = attach("bad.csv", LIST.replace("IT2C\r\n2025-0002", "IT2X\r\n2025-0002"));
r = await send(cmd2("import-classlist", o, res)); await settle();
check("[Class list] Import refuses sections that aren't set up (nothing imported)", followUp(r.token).includes("IT2X") && followUp(r.token).includes("Nothing was imported"));
[o, res] = attach("list.csv", LIST);
r = await send(cmd2("import-classlist", o, res));
check("[Class list] /import-classlist replies 'thinking' first", r.data.type === 5);
await settle();
check("[Class list] Import summary counts students per section", followUp(r.token).includes("Imported **5** students (2C: 3, 2E: 2)"), followUp(r.token).split("\n")[0]);

r = await send(cmd2("post-register")); await settle();
let p2 = discord.calls.filter((x) => x.path === "/channels/c2/messages").at(-1);
check("[Class list] Panel shows ONE Register button (no section choice)", p2.body.components[0].components.length === 1 && p2.body.components[0].components[0].custom_id === "reg:list");
check("[Class list] Panel explains the section comes from the class list", p2.body.embeds[0].description.includes("Mingming will put you in your section and open your class channels"));
r = await send(cmd2("post-register", [{ name: "style", value: "reregister" }])); await settle();
const pr = discord.calls.filter((x) => x.path === "/channels/c2/messages").at(-1).body;
check("[Panel] Re-registration style explains the tidy-up", pr.embeds[0].description.startsWith("## 📋 Re-register for ITC 120") && pr.embeds[0].description.includes("tidying up the server") && pr.embeds[0].description.includes("update your name in this server and put you in your correct section"), pr.embeds[0].description.split("\n")[0]);
r = await send({ ...cmd2("post-register", [{ name: "style", value: "reregister" }]), member: adminNamed() }); await settle();
const pn = discord.calls.filter((x) => x.path === "/channels/c2/messages").at(-1).body;
check("[Contact] Mention only, no separate bold name", pn.embeds[1].description.includes("Message your instructor, <@9>.") && !pn.embeds[1].description.includes("**Audrey Nanual**"), pn.embeds[1].description.split("\n").at(-1));
r = await send({ type: 3, guild_id: G2, member: student("41"), data: { custom_id: "reg:list" } });
check("[Class list] Register button opens the form", r.data.type === 9);

// Student believes they're in 2C (old role 901 + wrong section role), list says 2E; types lowercase, no ñ
discord.members.set("41", ["901", SEC_A, "777"]);
r = await submit2("41", "list", "maria clara", "pena", "maria@example.com");
p = patches2("41").at(-1);
check("[Class list] Section assigned FROM THE LIST (2E), wrong section + old role removed", p.body.roles.includes(SEC_B) && !p.body.roles.includes(SEC_A) && !p.body.roles.includes("901") && p.body.roles.includes("777") && p.body.roles.includes(STUDENT), JSON.stringify(p.body.roles));
check("[Class list] Nickname uses the official spelling (ñ) and list middle initial", p.body.nick === "Peña, Maria Clara B.", p.body.nick);
check("[Class list] Student is told the class list placed them", followUp(r.token).includes("class list shows you're in **BSIT 2E**") && followUp(r.token).includes("as it appears on the class list"));

discord.members.set("42", []);
r = await submit2("42", "list", "Juan", "Dela Cruz", "juan@example.com", "Santos");
check("[Class list] Only one given name typed: full official first name used", patches2("42").at(-1)?.body.nick === "Dela Cruz, Juan Miguel S.", patches2("42").at(-1)?.body.nick);

discord.members.set("43", []);
r = await submit2("43", "list", "Santos", "Jose", "jose@example.com");
check("[Class list] First/last swapped still matches; suffix taken from the list", patches2("43").at(-1)?.body.nick === "Santos, Jose Jr. R." && patches2("43").at(-1)?.body.roles.includes(SEC_B), patches2("43").at(-1)?.body.nick);

discord.members.set("47", []);
r = await submit2("47", "list", "Christopher", "Villanueva", "chris@example.com", "Diaz");
check("[Registrar typo] Student's correct spelling is kept (not the list's 'Christoper')", patches2("47").at(-1)?.body.nick === "Villanueva, Christopher D." && patches2("47").at(-1)?.body.roles.includes(SEC_A), patches2("47").at(-1)?.body.nick);
check("[Registrar typo] Message shows BOTH spellings and both possible fixes (typo vs. Registrar)",
  followUp(r.token).includes("The official class list has **Villanueva, Christoper D.**, but you typed **Villanueva, Christopher D.**, so I\'ve used your spelling") &&
  followUp(r.token).includes("If you made a typo") && followUp(r.token).includes("Registrar's Office"), followUp(r.token).split("\n").find((x) => x.includes("double-check")));

const { matchClassList: mcl } = await import("../src/index.js");
discord.members.set("48", []);
await send(cmd2("reset-student", [{ name: "student", value: "41" }])); await settle();
r = await submit2("48", "list", "Maria Clara", "Peña", "mc2@example.com", "Cruz");
check("[Middle initial] A different middle initial is kept and flagged, not silently replaced", patches2("48").at(-1)?.body.nick === "Peña, Maria Clara C." && followUp(r.token).includes("The official class list has **Peña, Maria Clara B.**"), patches2("48").at(-1)?.body.nick);
discord.members.set("49", []);
discord.members.set("45", []);
r = await submit2("45", "list", "Juan Miguel", "Dela Cruz", "copy@example.com");
check("[Class list] A name already registered by another account is refused", followUp(r.token).includes("already registered by another Discord account") && patches2("45").length === 0);

// Not on the list -> asked to double-check or pick a section
discord.members.set("44", ["901"]);
r = await submit2("44", "list", "Pedro", "Penduko", "pedro@example.com");
const prompt = discord.calls.filter((x) => x.path.includes(`/webhooks/app123/${r.token}/`)).at(-1).body;
check("[Class list] Not found: explains, offers section buttons, nothing changed yet", prompt.content.includes("couldn't find **Pedro Penduko**") && prompt.components[0].components.map((b) => b.custom_id).join(",") === `pick:${SEC_A},pick:${SEC_B}` && patches2("44").length === 0);
r = await send({ type: 3, guild_id: G2, member: student("44", ["901"]), data: { custom_id: `pick:${SEC_A}` } });
check("[Class list] Picking a section acknowledges the click", r.data.type === 6);
await settle();
p = patches2("44").at(-1);
check("[Class list] Picked section applied, old role removed", p?.body.roles.includes(SEC_A) && !p.body.roles.includes("901"), JSON.stringify(p?.body.roles));
const pickMsg = discord.calls.filter((x) => x.path.includes(`/webhooks/app123/${r.token}/`)).at(-1).body;
check("[Class list] Student told the instructor will double-check; buttons removed", pickMsg.content.includes("instructor will double-check") && pickMsg.components.length === 0);
r = await send({ type: 3, guild_id: G2, member: student("46"), data: { custom_id: `pick:${SEC_A}` } });
check("[Class list] A pick button without a pending registration is refused", r.data.data.content.includes("expired"));
const alerts = () => discord.calls.filter((x) => x.method === "POST" && x.path === "/channels/log-222/messages");
const notFoundAlert = alerts().find((a) => a.body.content.includes("isn't on the class list"));
check("[Alert] Not-on-list registration pings the instructor in the system channel", notFoundAlert && notFoundAlert.body.content.startsWith("<@9> 🔎 **Registration to double-check:** <@44>") && notFoundAlert.body.content.includes("Penduko, Pedro") && JSON.stringify(notFoundAlert.body.allowed_mentions) === JSON.stringify({ users: ["9"] }), notFoundAlert?.body.content.split("\n")[0]);
const differsAlert = alerts().find((a) => a.body.content.includes("but the class list has"));
check("[Alert] Name-differs registration shows both spellings to the instructor", differsAlert && differsAlert.body.content.includes("**Villanueva, Christopher D.**") && differsAlert.body.content.includes("**Villanueva, Christoper D.**"), differsAlert?.body.content.split("\n")[0]);
check("[Alert] Normal matching registrations don't ping the instructor", !alerts().some((a) => a.body.content.includes("<@42>") || a.body.content.includes("<@43>")));

r = await send(cmd2("settings"));
check("[Class list] /settings shows the list and who isn't on it", r.data.data.content.includes("**Class list:** 5 students (2C: 3, 2E: 2)") && r.data.data.content.includes("NOT on the class list:** 1") && r.data.data.content.includes("spelled differently from the class list:** 2"), r.data.data.content.split("\n").filter((l) => l.includes("lass list")).join(" | "));
csv = (await send(cmd2("export-roster"))).data;
check("[Class list] CSV includes Student ID and flags students not on the list", csv.includes('"Student ID","On Class List","Class List Spelling"') && csv.includes('"2025-0001","Yes"') && csv.includes('"","NO - please check"'));
check("[Registrar typo] CSV shows 'Yes, but name differs' with the registrar's spelling", csv.includes('"2025-0005","Yes, but name differs","Villanueva, Christoper D."'));

const { matchClassList } = await import("../src/index.js");
const twins = [{ student_id: "a", last_name: "CRUZ", first_name: "JUAN", middle_initial: "A." }, { student_id: "b", last_name: "CRUZ", first_name: "JUAN", middle_initial: "B." }];
check("[Class list] Two equally good matches are treated as 'not sure' (no guessing)", matchClassList(twins, { first: "Juan", middle: "", last: "Cruz" })?.ambiguous === true);
check("[Class list] Middle initial breaks the tie", matchClassList(twins, { first: "Juan", middle: "Bautista", last: "Cruz" })?.student_id === "b");
check("[Class list] A made-up name doesn't match", matchClassList(twins, { first: "Pedro", middle: "", last: "Penduko" }) === null);

r = await send(cmd2("unregistered"));
check("[Unregistered] Lists class-list students who haven't registered (1 of 5, by section)", r.ct.includes("multipart/form-data") && r.data.includes("**1 of 5** students") && r.data.includes("(2C: 1)") && r.data.includes('"2C","REYES","ANA"') && !r.data.includes("PEÑA"));
r = await send({ ...cmd2("unregistered"), member: student("20") });
check("[Unregistered] Students can't use it", r.data.data.content.includes("Only instructors"));
r = await send({ ...cmd("unregistered") });
check("[Unregistered] Without a class list, explains what to do", r.data.data.content.includes("no class list"));
r = await send(cmd2("clear-roster", [{ name: "confirm", value: "DELETE" }]));
check("[Class list] /clear-roster also deletes the class list", r.data.data.content.includes("Also deleted the class list (5 students)"));


console.log("\n▸ Class list in a one-section server (like IT 110)");
const G3 = "333";
const cmd3 = (name, options = [], resolved) => ({ type: 2, guild_id: G3, channel_id: "c3", member: admin(), data: { name, options, resolved } });
const patches3 = (uid) => discord.calls.filter((x) => x.method === "PATCH" && x.path === `/guilds/${G3}/members/${uid}`);
const form3 = (uid, f, l, e) => ({ type: 5, guild_id: G3, member: student(uid), data: { custom_id: "regform:list", components: [["first", f], ["middle", ""], ["last", l], ["suffix", ""], ["email", e]].map(([id, v]) => ({ type: 1, components: [{ type: 4, custom_id: id, value: v }] })) } });
await send(cmd3("setup", [{ name: "course_name", value: "IT 110: Introduction to Computing" }, { name: "student_role", value: STUDENT }, { name: "name_format", value: "last_first" }], role(STUDENT, "Student")));
await send(cmd3("retire-role", [{ name: "role", value: "902" }], role("902", "1A (unregistered)")));
[o, res] = attach("it110.csv", "ID No.,Last Name,First Name,M.I.,Ext.,Section\n2025-1001,LOPEZ,CARLO,M.,,IT1A\n");
r = await send(cmd3("import-classlist", o, res)); await settle();
check("[One section] Import works without sections set up (Section column ignored)", followUp(r.token).includes("Imported **1** students. 😺"), followUp(r.token).split("\n")[0]);
r = await send(cmd3("post-register")); await settle();
const p3 = discord.calls.filter((x) => x.path === "/channels/c3/messages").at(-1).body;
check("[One section] Panel: single Register button, no 'pick a section' wording", p3.components[0].components[0].custom_id === "reg:list" && !p3.embeds[0].description.includes("No need to pick a section"));
discord.members.set("51", ["902"]);
r = await send(form3("51", "carlo", "lopez", "carlo@example.com")); await settle();
check("[One section] Matched student: Student role only, old role removed, official name", patches3("51").at(-1)?.body.nick === "Lopez, Carlo M." && JSON.stringify(patches3("51").at(-1)?.body.roles) === JSON.stringify([STUDENT]), JSON.stringify(patches3("51").at(-1)?.body));
discord.members.set("52", []);
r = await send(form3("52", "Nobody", "Here", "nobody@example.com")); await settle();
const prompt3 = discord.calls.filter((x) => x.path.includes(`/webhooks/app123/${r.token}/`)).at(-1).body;
check("[One section] Not found: offers 'Register anyway'", prompt3.components[0].components[0].custom_id === "pick:none" && prompt3.components[0].components[0].label === "Register anyway");
r = await send({ type: 3, guild_id: G3, member: student("52"), data: { custom_id: "pick:none" } }); await settle();
check("[One section] 'Register anyway' registers and flags for review", patches3("52").at(-1)?.body.nick === "Here, Nobody" && followUp(r.token).includes("instructor will double-check"));
check("[Alert] No System Messages Channel: registration still works, no alert attempted", !discord.calls.some((x) => x.method === "POST" && x.path.startsWith("/channels/log-333")));

r = await send({ ...cmd("settings"), guild_id: "999" });
check("Other servers have separate settings", r.data.data.content.includes("isn't set up yet"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
