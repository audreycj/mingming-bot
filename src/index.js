/**
 * Mingming 🐱: a class registration bot for Discord, running on Cloudflare Workers.
 *
 * Discord sends every button click, form submission, and slash command to this
 * Worker as an HTTPS request. Mingming checks that the request really came from
 * Discord, does the work, and replies. Nothing needs to stay running.
 *
 * Settings and the student roster live in a Cloudflare D1 database (see schema.sql).
 */

const DEFAULT_API = "https://discord.com/api/v10";

// Interaction types Discord sends us
const PING = 1;
const APP_COMMAND = 2;
const COMPONENT = 3;
const MODAL_SUBMIT = 5;

// Response types we send back
const PONG = 1;
const MESSAGE = 4;
const DEFERRED_MESSAGE = 5;
const MODAL = 9;
const DEFERRED_UPDATE = 6; // acknowledge a button click and edit its message later

const EPHEMERAL = 64; // message visible only to the person who triggered it
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

// Permissions a student role must never carry (staff/moderator powers)
const DANGEROUS_PERMISSIONS =
  (1n << 1n) | // Kick Members
  (1n << 2n) | // Ban Members
  ADMINISTRATOR |
  (1n << 4n) | // Manage Channels
  MANAGE_GUILD |
  (1n << 7n) | // View Audit Log
  (1n << 13n) | // Manage Messages
  (1n << 17n) | // Mention @everyone
  (1n << 27n) | // Manage Nicknames
  (1n << 28n) | // Manage Roles
  (1n << 29n) | // Manage Webhooks
  (1n << 30n) | // Manage Expressions
  (1n << 33n) | // Manage Events
  (1n << 34n) | // Manage Threads
  (1n << 40n); // Timeout Members

const PANEL_COLOR = 0xf4a259; // orange, to match the cat avatar
const MAX_SECTIONS = 25; // Discord allows 25 buttons per message
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_REQUEST_AGE_SECONDS = 300; // reject replayed (old) requests
const LOCK_SECONDS = 60; // a stuck registration lock expires after this
const MAX_RETRY_WAIT_SECONDS = 5; // longer Discord waits: stop and ask the student to retry
const REQUEST_TIMEOUT_MS = 8000;
// Cloudflare allows ~30 seconds of background work after we reply "thinking...".
// Registration stops its Discord work by this budget, leaving time for the final reply.
const REGISTRATION_BUDGET_MS = 20000;
const REPLY_BUDGET_MS = 27000;

// ===========================================================================
// Entry point
// ===========================================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Mingming is here! 🐱", { status: 200 });
    }

    // 1. Security: reject anything not signed by Discord, or too old (replayed)
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_REQUEST_AGE_SECONDS;
    const valid =
      signature &&
      timestamp &&
      fresh &&
      (await verifySignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body));
    if (!valid) return new Response("Invalid request signature", { status: 401 });

    // 2. Route the interaction
    const interaction = JSON.parse(body);
    try {
      switch (interaction.type) {
        case PING:
          return json({ type: PONG });
        case APP_COMMAND:
          return await handleCommand(interaction, env, ctx);
        case COMPONENT:
          return await handleButton(interaction, env, ctx);
        case MODAL_SUBMIT:
          return await handleForm(interaction, env, ctx);
        default:
          return new Response("Unknown interaction type", { status: 400 });
      }
    } catch (err) {
      console.error("Unhandled error:", err);
      return reply("⚠️ Something went wrong on my end. Please try again in a moment.");
    }
  },
};

// ===========================================================================
// Instructor slash commands
// ===========================================================================
async function handleCommand(i, env, ctx) {
  if (!i.guild_id) return reply("Please use my commands inside a class server. 🐾");
  if (!isInstructor(i)) return reply("Only instructors can use this command. 😼");

  const opts = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
  const guild = i.guild_id;

  switch (i.data.name) {
    // ---------------------------------------------------------------- /setup
    case "setup": {
      const roleId = opts.student_role;
      const role = i.data.resolved?.roles?.[roleId];
      if (roleId === guild || role?.managed) {
        return reply("That role can't be used. Please pick a regular role, like **Student**.");
      }
      if (isDangerousRole(role)) return reply(DANGEROUS_ROLE_TEXT);
      const isSection = await env.DB.prepare("SELECT 1 FROM sections WHERE guild_id = ?1 AND role_id = ?2")
        .bind(guild, roleId)
        .first();
      if (isSection) return reply("That role is (or was) one of your sections. Please pick a separate **Student** role. 🐾");

      const course = opts.course_name.trim();
      await env.DB.prepare(
        `INSERT INTO servers (guild_id, course_name, student_role_id, name_format)
         VALUES (?1, ?2, ?3, COALESCE(?4, 'first_last'))
         ON CONFLICT(guild_id) DO UPDATE SET
           course_name = excluded.course_name,
           student_role_id = excluded.student_role_id,
           name_format = COALESCE(?4, servers.name_format)`
      )
        .bind(guild, course, roleId, opts.name_format ?? null)
        .run();
      return reply(
        `✅ Course set to **${course}**, and registered students will get <@&${roleId}>.\n\n` +
          "**Next steps:**\n" +
          "• If this server has several sections, add each one with **/add-section**.\n" +
          "• If the whole server is one class, skip that.\n" +
          "• Then run **/post-register** in your #start-here channel."
      );
    }

    // ---------------------------------------------------------- /add-section
    case "add-section": {
      const server = await getServer(env, guild);
      if (!server) return reply("Please run **/setup** first. 🐾");

      const roleId = opts.role;
      const role = i.data.resolved?.roles?.[roleId];
      if (roleId === guild || role?.managed) {
        return reply("That role can't be used as a section. Please pick a regular role, like **BSIT 2A**.");
      }
      if (roleId === server.student_role_id) {
        return reply("That's your Student role! Please pick a section role instead. 🐾");
      }
      if (isDangerousRole(role)) return reply(DANGEROUS_ROLE_TEXT);

      const sections = await getSections(env, guild);
      const exists = sections.some((s) => s.role_id === roleId);
      if (!exists && sections.length >= MAX_SECTIONS) {
        return reply(`You already have ${MAX_SECTIONS} sections, which is Discord's button limit.`);
      }

      const label = (opts.label?.trim() || role?.name?.trim() || "Section").slice(0, 80);
      const emoji = opts.emoji?.trim() || null;
      if (emoji && !isSingleEmoji(emoji)) {
        return reply("That doesn't look like a single emoji. Try one like 🟡, 🔵, or 🟢.");
      }
      await env.DB.prepare(
        `INSERT INTO sections (guild_id, role_id, label, active, emoji) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(guild_id, role_id) DO UPDATE SET
           label = excluded.label, active = 1, emoji = COALESCE(?4, sections.emoji)`
      )
        .bind(guild, roleId, label, emoji)
        .run();
      const shownEmoji = emoji || (await getSection(env, guild, roleId))?.emoji || "🐾";
      return reply(
        `${exists ? "Updated" : "Added"} section ${shownEmoji} **${label}** (<@&${roleId}>). 😺\n` +
          "Run **/post-register** again so the panel shows the change (then delete the old panel)."
      );
    }

    // ------------------------------------------------------- /remove-section
    case "remove-section": {
      // Kept as "retired" (not deleted) so its role is still stripped on re-registration
      const result = await env.DB.prepare(
        "UPDATE sections SET active = 0 WHERE guild_id = ?1 AND role_id = ?2 AND active = 1"
      )
        .bind(guild, opts.role)
        .run();
      if (!result.meta.changes) return reply("That role isn't one of your current sections. 🐾");
      return reply(
        `Removed <@&${opts.role}> from the panel. 😺\n` +
          "Run **/post-register** again so the panel shows the change (then delete the old panel).\n" +
          "Students already in that section keep their role until they re-register or you remove it."
      );
    }

    // ------------------------------------------------------------- /settings
    case "settings": {
      const server = await getServer(env, guild);
      if (!server) return reply("This server isn't set up yet. Run **/setup** to start. 🐾");
      const sections = await getSections(env, guild);
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM students WHERE guild_id = ?1")
        .bind(guild)
        .first();
      const sectionText = sections.length
        ? sections.map((s) => `• ${s.emoji || "🐾"} **${s.label.slice(0, 40)}** → <@&${s.role_id}>`).join("\n")
        : "None (one-class server: students just click **Register**)";
      const list = await env.DB.prepare(
        "SELECT section_code, COUNT(*) AS n FROM class_list WHERE guild_id = ?1 GROUP BY section_code ORDER BY section_code"
      )
        .bind(guild)
        .all();
      const listTotal = list.results.reduce((a, r) => a + r.n, 0);
      const offList = await env.DB.prepare("SELECT COUNT(*) AS n FROM students WHERE guild_id = ?1 AND on_list = 0")
        .bind(guild)
        .first();
      const differs = await env.DB.prepare("SELECT COUNT(*) AS n FROM students WHERE guild_id = ?1 AND on_list = 2")
        .bind(guild)
        .first();
      const listText = listTotal
        ? `${listTotal} students (${list.results.map((r) => `${r.section_code || "no section"}: ${r.n}`).join(", ")})` +
          (offList.n ? `\n**Registered but NOT on the class list:** ${offList.n} (see /export-roster)` : "") +
          (differs.n ? `\n**Name spelled differently from the class list:** ${differs.n} (see /export-roster)` : "")
        : "None (students pick their own section)";
      const text =
        `🐱 **Mingming settings**\n` +
        `**Course:** ${server.course_name}\n` +
        `**Student role:** <@&${server.student_role_id}>\n` +
        `**Nickname format:** ${server.name_format === "last_first" ? "Last, First" : "First Last"}\n` +
        `**Registered students:** ${n}\n` +
        `**Class list:** ${listText}\n` +
        `**Sections:**\n${sectionText}`;
      return reply(text.length > 1950 ? text.slice(0, 1950) + "\n…" : text);
    }

    // -------------------------------------------------------- /post-register
    case "post-register": {
      const server = await getServer(env, guild);
      if (!server) return reply("Please run **/setup** first. 🐾");
      const sections = await getSections(env, guild);
      const hasList = await hasClassList(env, guild);
      // Calls Discord, so reply "thinking..." first to stay within the 3-second limit
      ctx.waitUntil(postPanel(i, env, server, sections, hasList, opts.style === "reregister" ? "reregister" : "welcome"));
      return json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
    }

    // -------------------------------------------------------- /export-roster
    case "export-roster": {
      const server = await getServer(env, guild);
      const { results } = await env.DB.prepare(
        `SELECT * FROM students WHERE guild_id = ?1
         ORDER BY section COLLATE NOCASE, last_name COLLATE NOCASE, first_name COLLATE NOCASE`
      )
        .bind(guild)
        .all();
      if (!results.length) return reply("No one has registered yet. 🐾");

      const header = ["Last Name", "First Name", "Middle Name", "Suffix", "Section", "Email", "Student ID", "On Class List", "Class List Spelling", "Discord Username", "Registered (PH time)"];
      const rows = results.map((r) => [
        r.last_name,
        r.first_name,
        r.middle_name || "",
        r.suffix || "",
        r.section || "",
        r.email,
        r.student_id || "",
        r.on_list === 1 ? "Yes" : r.on_list === 2 ? "Yes, but name differs" : r.on_list === 0 ? "NO - please check" : "",
        r.list_name || "",
        r.username || "",
        new Date(r.registered_at).toLocaleString("en-US", { timeZone: "Asia/Manila" }),
      ]);
      // The BOM (\uFEFF) makes Excel read accents like "ñ" correctly
      const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      const filename = `${slugify(server?.course_name || "class")}-roster.csv`;

      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          type: MESSAGE,
          data: {
            content: `📋 Here's your roster: **${results.length}** registered student(s). Only you can see this message. 😺`,
            flags: EPHEMERAL,
            attachments: [{ id: 0, filename }],
          },
        })
      );
      form.append("files[0]", new Blob([csv], { type: "text/csv" }), filename);
      return new Response(form);
    }

    // ----------------------------------------------------- /import-classlist
    case "import-classlist": {
      const server = await getServer(env, guild);
      if (!server) return reply("Please run **/setup** first. 🐾");
      const file = i.data.resolved?.attachments?.[opts.file];
      if (!file) return reply("I couldn't read that file. Please attach a CSV file.");
      // Downloads and saves the list, so reply "thinking..." first (3-second rule)
      ctx.waitUntil(importClassList(i, env, file));
      return json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
    }

    // --------------------------------------------------------- /unregistered
    case "unregistered": {
      if (!(await hasClassList(env, guild))) {
        return reply("There's no class list for this server yet. Upload one with **/import-classlist** first. 🐾");
      }
      const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM class_list WHERE guild_id = ?1").bind(guild).first()).n;
      const { results } = await env.DB.prepare(
        `SELECT c.* FROM class_list c
         WHERE c.guild_id = ?1
           AND NOT EXISTS (SELECT 1 FROM students s WHERE s.guild_id = c.guild_id AND s.student_id = c.student_id)
         ORDER BY c.section_code, c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`
      )
        .bind(guild)
        .all();
      if (!results.length) return reply(`🎉 Everyone on the class list (${total}) has registered! 😺`);

      const counts = {};
      for (const r of results) counts[r.section_code || "all"] = (counts[r.section_code || "all"] || 0) + 1;
      const header = ["Section", "Last Name", "First Name", "M.I.", "Ext.", "ID No."];
      const rows = results.map((r) => [r.section_code || "", r.last_name, r.first_name, r.middle_initial || "", r.suffix || "", r.student_id]);
      const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
      const server = await getServer(env, guild);
      const filename = `${slugify(server?.course_name || "class")}-not-registered.csv`;
      const bySection = Object.keys(counts).length > 1 || !counts.all
        ? ` (${Object.entries(counts).sort().map(([k, n]) => `${k}: ${n}`).join(", ")})` : "";
      const form = new FormData();
      form.append("payload_json", JSON.stringify({
        type: MESSAGE,
        data: {
          content:
            `📋 **${results.length} of ${total}** students on the class list haven't registered yet${bySection}. Full list attached.\n` +
            "This includes students who haven't joined the server at all. Students who registered but weren't found on the list " +
            "(\"NO - please check\" in /export-roster) may also appear here if their name was spelled very differently.",
          flags: EPHEMERAL,
          attachments: [{ id: 0, filename }],
        },
      }));
      form.append("files[0]", new Blob([csv], { type: "text/csv" }), filename);
      return new Response(form);
    }

    // ---------------------------------------------------------- /retire-role
    case "retire-role": {
      const server = await getServer(env, guild);
      if (!server) return reply("Please run **/setup** first. 🐾");
      const roleId = opts.role;
      const role = i.data.resolved?.roles?.[roleId];
      if (roleId === guild || role?.managed || roleId === server.student_role_id) {
        return reply("That role can't be retired. Pick an old section role (like one from another bot). 🐾");
      }
      await env.DB.prepare(
        `INSERT INTO sections (guild_id, role_id, label, active) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(guild_id, role_id) DO UPDATE SET active = 0`
      )
        .bind(guild, roleId, (role?.name || "Old role").slice(0, 80))
        .run();
      return reply(
        `Got it! 🧹 <@&${roleId}> will be removed automatically when each student registers.\n` +
          "Students keep it (and the channels it opens) until then, so nobody misses your announcements."
      );
    }

    // -------------------------------------------------------- /reset-student
    case "reset-student": {
      const server = await getServer(env, guild);
      if (!server) return reply("Please run **/setup** first. 🐾");
      // Calls Discord, so reply "thinking..." first to stay within the 3-second limit
      ctx.waitUntil(resetStudent(i, env, server, opts.student));
      return json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
    }

    // --------------------------------------------------------- /clear-roster
    case "clear-roster": {
      if ((opts.confirm || "").trim() !== "DELETE") {
        return reply(
          "Nothing was deleted. 🐾 To erase Mingming's saved names and emails for this server, run " +
            "**/clear-roster** again and type `DELETE` (in capitals) in the confirm box.\n" +
            "Tip: run **/export-roster** first to keep a copy."
        );
      }
      const result = await env.DB.prepare("DELETE FROM students WHERE guild_id = ?1").bind(guild).run();
      const listResult = await env.DB.prepare("DELETE FROM class_list WHERE guild_id = ?1").bind(guild).run();
      await env.DB.prepare("DELETE FROM pending WHERE guild_id = ?1").bind(guild).run();
      return reply(
        `Deleted **${result.meta.changes}** saved registration(s) from Mingming's list for this server. 🧹\n` +
          (listResult.meta.changes ? `Also deleted the class list (${listResult.meta.changes} students).\n` : "") +
          "This only deletes Mingming's saved data. Students keep their Discord nicknames and roles, and " +
          "anyone still in the server can register again. Copies you exported earlier are not affected."
      );
    }

    default:
      return reply("I don't know that command.");
  }
}

async function resetStudent(i, env, server, userId) {
  const guild = i.guild_id;
  const done = (content) =>
    discord(
      env,
      `/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,
      { method: "PATCH", body: JSON.stringify({ content }) },
      { attempts: 3, auth: false }
    ).catch((err) => console.error("Could not edit reply:", err));

  try {
    if (userId === guild || userId === i.member.user.id) {
      return await done("You can't reset yourself. Pick a student instead.");
    }
    await env.DB.prepare("DELETE FROM pending WHERE guild_id = ?1 AND user_id = ?2").bind(guild, userId).run();
    const deleteEntry = () =>
      env.DB.prepare("DELETE FROM students WHERE guild_id = ?1 AND user_id = ?2").bind(guild, userId).run();

    const memberRes = await discord(env, `/guilds/${guild}/members/${userId}`, {}, { attempts: 3 });
    if (memberRes.status === 404) {
      const result = await deleteEntry();
      return await done(
        result.meta.changes
          ? `<@${userId}> is no longer in this server, so I just deleted their saved entry. 🧹`
          : `<@${userId}> isn't in this server and has no saved entry. Nothing to reset. 🐾`
      );
    }
    if (!memberRes.ok) return await done(`I couldn't look up that member (Discord error ${memberRes.status}). 😿 Please try again.`);

    // Remove Student and every section role (current or retired); keep everything else
    const classRoles = new Set([server.student_role_id, ...(await getAllSectionRoleIds(env, guild))]);
    const currentRoles = (await memberRes.json()).roles || [];
    const roles = currentRoles.filter((id) => !classRoles.has(id));

    const res = await discord(
      env,
      `/guilds/${guild}/members/${userId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ nick: null, roles }),
        headers: { "X-Audit-Log-Reason": "Reset through Mingming" },
      },
      { attempts: 3 }
    );
    if (!res.ok) {
      return await done(
        res.status === 403
          ? "I don't have permission to reset that member. 😿 Make sure my role is above theirs (and note that I can't change the server owner)."
          : `Discord didn't accept the reset (error ${res.status}). 😿 Please try again.`
      );
    }

    const deleted = await withRetries(deleteEntry);
    await done(
      `Reset <@${userId}>. 🧹 Their nickname, class roles${deleted ? ", and saved entry were" : " were"} removed, ` +
        "so they're back to seeing only the registration panel and can register again." +
        (deleted ? "" : "\n⚠️ I couldn't delete their saved entry just now. Please run the command again.")
    );
  } catch (err) {
    console.error("resetStudent error:", err);
    await done("Something went wrong or Discord was too slow. 😿 Please try again.");
  }
}

async function postPanel(i, env, server, sections, hasList, style) {
  const done = (content) =>
    discord(
      env,
      `/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,
      { method: "PATCH", body: JSON.stringify({ content }) },
      { attempts: 3, auth: false }
    ).catch((err) => console.error("Could not edit reply:", err));

  try {
    const res = await discord(
      env,
      `/channels/${i.channel_id}/messages`,
      // The instructor who posts the panel is the one students are told to contact
      { method: "POST", body: JSON.stringify(buildPanel(server, sections, i.member.user.id, hasList, style,
        i.member.nick || i.member.user.global_name || i.member.user.username)) },
      { attempts: 2 }
    );
    if (res.ok) {
      await done("Registration panel posted! 😺 If there's an older panel in this channel, you can delete it.");
    } else {
      await done(
        `I couldn't post in this channel (Discord error ${res.status}). 😿\n` +
          "Please give Mingming **View Channel**, **Send Messages**, and **Embed Links** in this channel."
      );
    }
  } catch (err) {
    console.error("postPanel error:", err);
    await done("Discord didn't respond in time. 😿 Please check whether the panel appeared, and try again if not.");
  }
}

// ===========================================================================
// Student clicks a Register button -> show the form
// ===========================================================================
async function handleButton(i, env, ctx) {
  const [kind, sectionId] = (i.data.custom_id || "").split(":");
  if (kind === "pick") return handlePick(i, env, ctx, sectionId);
  if (kind !== "reg") return reply("Hmm, I don't recognize that button.");

  const server = await getServer(env, i.guild_id);
  if (!server) return reply("Registration isn't set up yet. Please let your instructor know. 🐱");

  if (await isRegistered(env, i.guild_id, i.member.user.id, i.member.roles, server)) {
    return reply(ALREADY_REGISTERED);
  }

  let title = "🐾 Tell Mingming about you!";
  if (sectionId === "list") {
    if (!(await hasClassList(env, i.guild_id))) return reply(OUTDATED_PANEL);
  } else if (sectionId === "none") {
    const sections = await getSections(env, i.guild_id);
    if (sections.length) return reply(OUTDATED_PANEL);
  } else {
    const section = await getSection(env, i.guild_id, sectionId);
    if (!section) return reply(OUTDATED_PANEL);
    title = `${section.emoji || "🐾"} Register for ${section.label}`;
  }

  return json({
    type: MODAL,
    data: {
      custom_id: `regform:${sectionId}`,
      title: title.slice(0, 45),
      components: [
        textInput("first", "Complete First Name", "e.g., Juan Miguel (not Migs or JM)", 40),
        textInput("middle", "Middle Name (optional)", "e.g., Santos. Leave blank if you have none.", 40, false),
        textInput("last", "Last Name", "e.g., Dela Cruz", 40),
        textInput("suffix", "Suffix (optional)", "e.g., Jr., Sr., III. Leave blank if none.", 10, false),
        textInput("email", "Email Address", "e.g., juan.delacruz@gmail.com", 100),
      ],
    },
  });
}

const OUTDATED_PANEL =
  "⚠️ This registration panel is out of date. Please let your instructor know so they can post a new one.";
const ALREADY_REGISTERED =
  "✅ You're already registered. If something needs fixing, please message your instructor.";

// ===========================================================================
// Student submits the form -> validate, then register in the background
// ===========================================================================
async function handleForm(i, env, ctx) {
  const sectionId = (i.data.custom_id || "").split(":")[1];
  const fields = {};
  for (const row of i.data.components || []) {
    for (const c of row.components || []) fields[c.custom_id] = c.value ?? "";
  }

  const first = tidyName(fields.first || "");
  const middle = tidyName(fields.middle || "");
  const last = tidyName(fields.last || "");
  const suffix = tidySuffix(fields.suffix || "");
  const email = (fields.email || "").trim().toLowerCase();

  // The panel shows one "Register" button (class list or no sections) or one
  // button per section, so point the student to the button they actually see.
  const retry =
    sectionId === "list" || sectionId === "none"
      ? "Click **Register** to try again."
      : "Click **your section's button** to try again.";

  if (!isValidName(first) || !isValidName(last) || (middle && !isValidName(middle))) {
    return reply(
      "⚠️ That doesn't look like a real name. Please use letters only " +
        "(periods, hyphens, and apostrophes are okay). " + retry
    );
  }
  if (!EMAIL_PATTERN.test(email)) {
    return reply("⚠️ That email address doesn't look right. " + retry);
  }
  if (suffix === null) {
    return reply("⚠️ Suffix should be something like Jr., Sr., II, III, or IV. " + retry);
  }

  // Discord needs a reply within 3 seconds, so we say "thinking..." now
  // and finish the registration in the background.
  ctx.waitUntil(register(i, env, { first, middle, last, suffix, email, sectionId }));
  return json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
}

async function register(i, env, { first, middle, last, suffix, email, sectionId, fromPick = false }) {
  const started = Date.now();
  const deadline = started + Number(env.REGISTRATION_BUDGET_MS || REGISTRATION_BUDGET_MS);
  const replyDeadline = started + Number(env.REPLY_BUDGET_MS || REPLY_BUDGET_MS);
  const say = (content, components = []) =>
    discord(
      env,
      `/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,
      { method: "PATCH", body: JSON.stringify({ content, components }) },
      { attempts: 3, auth: false, deadline: replyDeadline }
    ).catch((err) => console.error("Could not send reply:", err));

  const guild = i.guild_id;
  const user = i.member.user;

  // One registration at a time per student. A second submission (e.g., from
  // another device) is turned away instead of racing the first one.
  let locked = false;
  try {
    locked = await claimLock(env, guild, user.id);
  } catch (err) {
    console.error("Lock error:", err);
    return await say("⚠️ Something went wrong on my end. Please try registering again in a minute.");
  }
  if (!locked) {
    return await say("I'm already working on a registration for you. ⏳ Please wait a moment, then check your channels.");
  }

  try {
    const server = await getServer(env, guild);
    if (!server) return await say("Registration isn't set up yet. Please let your instructor know. 🐱");

    // Fresh look at the student's current roles (not the snapshot from when they clicked)
    const memberRes = await discord(env, `/guilds/${guild}/members/${user.id}`, {}, { attempts: 3, deadline });
    if (!memberRes.ok) return await say(failureMessage(memberRes.status));
    const currentRoles = (await memberRes.json()).roles || [];

    if (await isRegistered(env, guild, user.id, currentRoles, server)) return await say(ALREADY_REGISTERED);

    // Class list: find the student and use the section (and official name) from the list
    let section = null;
    let studentId = null;
    let onList = fromPick ? 0 : null;
    let usedOfficialName = false;
    let listName = null;
    if (sectionId === "list") {
      const entries = await getClassList(env, guild);
      if (!entries.length) return await say(OUTDATED_PANEL);
      const match = matchClassList(entries, { first, middle, last });
      if (!match || match.ambiguous) {
        await env.DB.prepare(
          `INSERT INTO pending (guild_id, user_id, first_name, middle_name, last_name, suffix, email, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(guild_id, user_id) DO UPDATE SET first_name = excluded.first_name, middle_name = excluded.middle_name,
             last_name = excluded.last_name, suffix = excluded.suffix, email = excluded.email, created_at = excluded.created_at`
        )
          .bind(guild, user.id, first, middle || null, last, suffix || null, email, Math.floor(Date.now() / 1000))
          .run();
        const sections = await getSections(env, guild);
        const buttons = sections.length
          ? sections.slice(0, MAX_SECTIONS).map((s) => button(s.label, `pick:${s.role_id}`, s.emoji))
          : [button("Register anyway", "pick:none", "✅")];
        const typed = [first, middle, last, suffix].filter(Boolean).join(" ");
        return await say(
          `🔎 I couldn't find **${typed}** on the class list.\n\n` +
            "**If you made a typo:** dismiss this message and click **Register** again, typing your complete name carefully (not a nickname).\n\n" +
            (sections.length
              ? "**If your name is correct:** pick your section below. Your instructor will double-check it."
              : "**If your name is correct:** click the button below. Your instructor will double-check it."),
          buttonRows(buttons)
        );
      }
      const claimed = await env.DB.prepare("SELECT user_id FROM students WHERE guild_id = ?1 AND student_id = ?2")
        .bind(guild, match.student_id)
        .first();
      if (claimed && claimed.user_id !== user.id) {
        return await say(
          "⚠️ That name is already registered by another Discord account. If that wasn't you, please message your instructor."
        );
      }
      const sections = await getSections(env, guild);
      if (sections.length) {
        section = sections.find((s) => sectionCode(s.label) === match.section_code) || null;
        if (!section) {
          return await say(
            `I found you on the class list, but your section (${match.section_code || "none"}) isn't set up here yet. 😿 Please let your instructor know.`
          );
        }
      }
      // If the student typed their first and last name in the wrong boxes, put them back
      if (!lastNameScore(last, match.last_name)) [first, last] = [last, first];
      // Registrar lists can contain misspellings, so:
      // - same name, only formatting differs (case, ñ, a missing extra given name) -> use the list's version
      // - the letters actually differ -> trust the student's spelling and flag it for the instructor
      const decide = (typed, listed, isFirst) => {
        const L = (listed || "").trim();
        if (!L || typed.toLowerCase() === L.toLowerCase()) return { value: typed, differs: false };
        if (normName(typed) === normName(L)) return { value: tidyName(L), differs: false };
        if (tokens(typed).join(" ") === tokens(L).join(" ")) return { value: typed, differs: false }; // "Maria" for "Ma."
        if (isFirst) {
          const A = tokens(typed), B = tokens(L);
          if (A.length < B.length && A.every((t) => B.includes(t))) return { value: tidyName(L), differs: false };
        }
        return { value: typed, differs: true };
      };
      const f = decide(first, match.first_name, true), l = decide(last, match.last_name, false);
      usedOfficialName = f.value !== first || l.value !== last;
      first = f.value;
      last = l.value;
      // Middle initial: fill it in from the list if the student left it blank; if they typed a
      // different one, keep theirs and flag it (the list may be wrong)
      const listedMi = normName(match.middle_initial || "").charAt(0);
      const typedMi = normName(middle || "").charAt(0);
      const miDiffers = Boolean(listedMi && typedMi && typedMi !== listedMi);
      if (listedMi && !typedMi) middle = `${listedMi.toUpperCase()}.`;
      if (f.differs || l.differs || miDiffers) {
        listName = [`${tidyName(match.last_name)},`, tidyName(match.first_name), listedMi ? `${listedMi.toUpperCase()}.` : ""]
          .filter(Boolean).join(" ");
      }
      suffix = tidySuffix(match.suffix || "") || suffix;
      studentId = match.student_id;
      onList = listName ? 2 : 1;
    } else if (sectionId === "none") {
      if ((await getSections(env, guild)).length) return await say(OUTDATED_PANEL);
    } else {
      section = await getSection(env, guild, sectionId);
      if (!section) return await say(OUTDATED_PANEL);
    }

    // Safety check: refuse if a class role has gained staff permissions since setup
    const rolesRes = await discord(env, `/guilds/${guild}/roles`, {}, { attempts: 3, deadline });
    if (!rolesRes.ok) return await say(failureMessage(rolesRes.status));
    const serverRoles = new Map((await rolesRes.json()).map((r) => [r.id, r]));
    const granting = [server.student_role_id, ...(section ? [section.role_id] : [])];
    if (granting.some((id) => !serverRoles.has(id))) return await say(failureMessage(404));
    if (granting.some((id) => isDangerousRole(serverRoles.get(id)))) {
      return await say(
        "⚠️ I can't finish your registration because a class role has staff permissions. Please let your instructor know."
      );
    }

    // New role list: keep the student's unrelated roles, remove EVERY section role
    // this server has ever used (current or retired), then add Student + chosen section.
    const everySection = new Set(await getAllSectionRoleIds(env, guild));
    const roles = new Set(currentRoles.filter((id) => !everySection.has(id)));
    for (const id of granting) roles.add(id);

    const { nick, shortened } = buildNickname(server.name_format, { first, middle, last, suffix });

    // Step 1: nickname AND roles in ONE Discord request
    const res = await discord(
      env,
      `/guilds/${guild}/members/${user.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ nick, roles: [...roles] }),
        headers: { "X-Audit-Log-Reason": "Registered through Mingming" },
      },
      { attempts: 3, deadline }
    );
    if (!res.ok) {
      // Nothing was saved, so any earlier roster entry stays untouched.
      console.error("Member update failed:", res.status, await res.text());
      return await say(failureMessage(res.status));
    }

    // Step 2: only after Discord succeeds, save the roster entry
    const saved = await withRetries(() =>
      env.DB.prepare(
        `INSERT INTO students (guild_id, user_id, username, first_name, middle_name, last_name, suffix, email, section, section_role_id, student_id, on_list, list_name, registered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           username = excluded.username, first_name = excluded.first_name, middle_name = excluded.middle_name,
           last_name = excluded.last_name, suffix = excluded.suffix, email = excluded.email,
           section = excluded.section, section_role_id = excluded.section_role_id, student_id = excluded.student_id,
           on_list = excluded.on_list, list_name = excluded.list_name, registered_at = excluded.registered_at`
      )
        .bind(guild, user.id, user.username, first, middle || null, last, suffix || null, email,
              section?.label ?? null, section?.role_id ?? null, studentId, onList, listName, new Date().toISOString())
        .run()
    );
    if (!saved) {
      // Remove any old entry so the student counts as unregistered and can simply retry
      const cleaned = await withRetries(() =>
        env.DB.prepare("DELETE FROM students WHERE guild_id = ?1 AND user_id = ?2").bind(guild, user.id).run()
      );
      console.error("Roster save failed for", guild, user.id, cleaned ? "(old entry removed)" : "(cleanup ALSO failed)");
      if (cleaned) {
        return await say(
          `You're in, **${nick}**! 😺 But I couldn't save your details just now. ` +
            "Please click your section's button again in a few minutes to finish."
        );
      }
      return await say(
        `You're in, **${nick}**! 😺 But I couldn't save your details. ` +
          "Please ask your instructor to remove your **Student** role, then register again."
      );
    }

    await env.DB.prepare("DELETE FROM pending WHERE guild_id = ?1 AND user_id = ?2").bind(guild, user.id).run().catch(() => {});
    const generalId = await findGeneralChannel(env, guild, section, deadline);
    const listNote =
      onList >= 1
        ? (section ? `🔎 The class list shows you're in **${section.label}**, so that's where I've put you.\n` : "") +
          (onList === 2
            ? `\n📝 **Please double-check your name.** The official class list has **${listName}**, but you typed ` +
              `**${[`${last},`, first, middle ? `${middle.charAt(0).toUpperCase()}.` : ""].filter(Boolean).join(" ")}**, so I've used your spelling for now.\n` +
              "• **If you made a typo:** message your instructor so it can be fixed.\n" +
              "• **If your spelling is correct:** the school's record may have an error. Please have it corrected at the " +
              "**Registrar's Office** (your adviser can guide you), since it can affect official documents like your transcript and diploma.\n"
            : usedOfficialName ? "✏️ I used your name as it appears on the class list.\n" : "") + "\n"
        : onList === 0
          ? "🔎 I couldn't find you on the class list, so your instructor will double-check your registration.\n\n"
          : "";
    if (onList === 0 || onList === 2) {
      await notifyInstructor(env, guild, replyDeadline,
        onList === 0
          ? `registered as **${nick}**${section ? ` (${section.label})` : ""}, but isn't on the class list.`
          : `registered as **${nick}**${section ? ` (${section.label})` : ""}, but the class list has **${listName}** instead (a typo or a registrar error?)`,
        user.id);
    }
    await say(
      `✅ **You're registered, ${nick}**${section ? ` (${section.label})` : ""}!\n` +
        listNote +
        "You now have access to your class channels." +
        (generalId ? ` Come say hi in <#${generalId}>! 👋` : "") +
        "\n\n" +
        (shortened
          ? "✂️ Your nickname was shortened to fit Discord's 32-character limit. Your full name is saved in the class records.\n\n"
          : "") +
        `📧 Your email is saved as **${email}**. Please check it carefully. If anything is wrong, message your instructor.`
    );
  } catch (err) {
    console.error("Registration error:", err);
    await say(
      "⚠️ Something went wrong or Discord was too slow. " +
        "If you can't see your class channels yet, please try registering again in a minute."
    );
  } finally {
    await releaseLock(env, guild, user.id).catch((err) => console.error("Unlock error:", err));
  }
}

// ===========================================================================
// Class list: import, lookup, and the "not on the list" fallback
// ===========================================================================
const PENDING_SECONDS = 1800; // a "not found" prompt stays usable for 30 minutes

/** Student clicks a section (or "Register anyway") after not being found on the class list */
async function handlePick(i, env, ctx, sectionId) {
  const guild = i.guild_id;
  const p = await env.DB.prepare("SELECT * FROM pending WHERE guild_id = ?1 AND user_id = ?2")
    .bind(guild, i.member.user.id)
    .first();
  if (!p || p.created_at < Math.floor(Date.now() / 1000) - PENDING_SECONDS) {
    return reply("⚠️ This registration has expired. Please click **Register** in the welcome channel again.");
  }
  if (sectionId !== "none" && !(await getSection(env, guild, sectionId))) return reply(OUTDATED_PANEL);
  ctx.waitUntil(
    register(i, env, {
      first: p.first_name, middle: p.middle_name || "", last: p.last_name, suffix: p.suffix || "",
      email: p.email, sectionId, fromPick: true,
    })
  );
  return json({ type: DEFERRED_UPDATE });
}

async function hasClassList(env, guild) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM class_list WHERE guild_id = ?1 LIMIT 1").bind(guild).first());
}

async function getClassList(env, guild) {
  return (await env.DB.prepare("SELECT * FROM class_list WHERE guild_id = ?1").bind(guild).all()).results;
}

/** "IT2C", "BSIT 2C", "IT 2C" -> "2C" */
export function sectionCode(text) {
  const m = /(\d+)\s*([A-Za-z]+)\s*$/.exec(String(text || "").trim());
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

/** Lowercase, no accents (ñ -> n), letters only, single spaces */
export function normName(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z]+/g, " ").trim();
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, k) => [k]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let x = 1; x <= a.length; x++)
    for (let y = 1; y <= b.length; y++)
      d[x][y] = Math.min(d[x-1][y] + 1, d[x][y-1] + 1, d[x-1][y-1] + (a[x-1] === b[y-1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Small typos allowed: 1 for words of 4-7 letters, 2 for 8+ */
function closeEnough(a, b) {
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  return len >= 8 ? dist <= 2 : len >= 4 ? dist <= 1 : false;
}

const tokens = (s) => normName(s).split(" ").filter(Boolean).map((t) => (t === "ma" ? "maria" : t));

function lastNameScore(typed, listed) {
  const a = tokens(typed).join(""), b = tokens(listed).join("");
  if (!a || !b) return 0;
  return a === b ? 1 : closeEnough(a, b) ? 0.7 : 0;
}

function firstNameScore(typed, listed) {
  const A = tokens(typed), B = tokens(listed);
  if (!A.length || !B.length) return 0;
  if (A.join("") === B.join("")) return 1;
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  // e.g. typed "Juan" for "Juan Miguel" (or the other way around)
  if (S.every((t) => L.includes(t))) return 0.85;
  if (S.every((t) => L.some((x) => closeEnough(x, t)))) return 0.75;
  return closeEnough(A.join(""), B.join("")) ? 0.8 : 0;
}

/**
 * Finds the student on the class list. Tolerates capitalization, accents, a missing
 * extra given name, small typos, and first/last name typed in the wrong boxes.
 * Returns the entry, { ambiguous: true } when two entries fit equally well, or null.
 */
export function matchClassList(entries, { first, middle, last }) {
  const typedMi = normName(middle).charAt(0);
  const scored = [];
  for (const e of entries) {
    let best = 0;
    for (const [f, l] of [[first, last], [last, first]]) {
      const ls = lastNameScore(l, e.last_name), fs = firstNameScore(f, e.first_name);
      if (ls > 0 && fs > 0) best = Math.max(best, ls + fs);
    }
    if (!best) continue;
    const listedMi = normName(e.middle_initial).charAt(0);
    if (typedMi && listedMi) best += typedMi === listedMi ? 0.2 : -0.3;
    scored.push({ e, s: best });
  }
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 1.5) return null;
  if (scored[1] && scored[0].s - scored[1].s < 0.15) return { ambiguous: true };
  return scored[0].e;
}

/** Minimal CSV parser (quotes, commas inside quotes, CRLF, BOM) */
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (q) {
      if (c === '"' && text[k+1] === '"') { cell += '"'; k++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[k+1] === "\n") k++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

async function importClassList(i, env, file) {
  const guild = i.guild_id;
  const done = (content) =>
    discord(env, `/webhooks/${env.DISCORD_APPLICATION_ID}/${i.token}/messages/@original`,
      { method: "PATCH", body: JSON.stringify({ content }) }, { attempts: 3, auth: false })
      .catch((err) => console.error("Could not edit reply:", err));
  try {
    if (!/\.csv$/i.test(file.filename || "") || (file.size || 0) > 1_000_000) {
      return await done("Please attach a **.csv** file (under 1 MB). 🐾 In Excel: File → Save As → CSV UTF-8.");
    }
    const res = await fetch(file.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return await done("I couldn't download that file. 😿 Please try again.");
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return await done("That file looks empty.");

    const header = rows[0].map((h) => normName(h));
    const col = (...names) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
    const c = {
      id: col("id no", "id", "student id", "student no"), last: col("last name", "last", "surname"),
      first: col("first name", "first", "given name"), mi: col("m i", "mi", "middle"),
      ext: col("ext", "suffix", "extension"), section: col("section"),
    };
    if (c.last < 0 || c.first < 0) {
      return await done("I need at least a **Last Name** and a **First Name** column in the first row.");
    }
    const sections = await getSections(env, guild);
    const known = new Set(sections.map((s) => sectionCode(s.label)));
    if (sections.length && c.section < 0) {
      return await done("This server has sections, so the file needs a **Section** column (e.g., IT2C).");
    }

    const entries = [], seen = new Set(), unknown = new Set();
    rows.slice(1).forEach((r, k) => {
      const last = (r[c.last] || "").trim(), first = (r[c.first] || "").trim();
      if (!last || !first) return;
      const id = (c.id >= 0 && (r[c.id] || "").trim()) || `row-${k + 2}`;
      if (seen.has(id)) return;
      seen.add(id);
      const code = sections.length ? sectionCode(r[c.section]) : null;
      if (sections.length && !known.has(code)) unknown.add((r[c.section] || "(blank)").trim());
      entries.push([guild, id, last, first, c.mi >= 0 ? (r[c.mi] || "").trim() || null : null,
        c.ext >= 0 ? (r[c.ext] || "").trim() || null : null, code]);
    });
    if (unknown.size) {
      return await done(
        `These sections in the file don't match any section set up here: **${[...unknown].join(", ")}**.\n` +
          "Add them with **/add-section** first, or fix the file. Nothing was imported."
      );
    }
    if (!entries.length) return await done("I couldn't find any students in that file.");

    const stmts = [env.DB.prepare("DELETE FROM class_list WHERE guild_id = ?1").bind(guild)];
    for (const e of entries) {
      stmts.push(env.DB.prepare(
        `INSERT INTO class_list (guild_id, student_id, last_name, first_name, middle_initial, suffix, section_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(...e));
    }
    await env.DB.batch(stmts);

    const counts = {};
    for (const e of entries) counts[e[6] || "all"] = (counts[e[6] || "all"] || 0) + 1;
    await done(
      `📋 Imported **${entries.length}** students` +
        (sections.length ? ` (${Object.entries(counts).sort().map(([k, n]) => `${k}: ${n}`).join(", ")})` : "") + ". 😺\n" +
        "Any previous class list for this server was replaced.\n" +
        "Run **/post-register** again so the panel switches to a single **Register** button, then delete the old panel."
    );
  } catch (err) {
    console.error("importClassList error:", err);
    await done("Something went wrong while importing. 😿 Please check the file and try again.");
  }
}

/**
 * Pings the server owner (the instructor) in the server's System Messages Channel
 * (e.g. #join-log) when a registration needs a human check. Best effort: if there's
 * no such channel or Mingming can't post there, registration still succeeds.
 */
async function notifyInstructor(env, guild, deadline, what, studentId) {
  try {
    const res = await discord(env, `/guilds/${guild}`, {}, { attempts: 2, deadline });
    if (!res.ok) return;
    const g = await res.json();
    if (!g.system_channel_id || !g.owner_id) return;
    const post = await discord(env, `/channels/${g.system_channel_id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content:
          `<@${g.owner_id}> 🔎 **Registration to double-check:** <@${studentId}> ${what}\n` +
          "Review it with **/export-roster**, or **/reset-student** them so they can register again.",
        allowed_mentions: { users: [g.owner_id] }, // ping only the instructor, not the student
      }),
    }, { attempts: 2, deadline });
    if (!post.ok) console.error("notifyInstructor: couldn't post in the system channel:", post.status);
  } catch (err) {
    console.error("notifyInstructor:", err);
  }
}

const VIEW_CHANNEL = 1n << 10n;

/**
 * Finds the student's #general chat, with no setup needed:
 * - with sections: the text channel named "general" inside a category that the section role is allowed to view
 * - without sections: the server's text channel named "general"
 * Best effort: returns null if not found or if Discord is slow, and registration still succeeds.
 */
async function findGeneralChannel(env, guild, section, deadline) {
  try {
    const res = await discord(env, `/guilds/${guild}/channels`, {}, { attempts: 2, deadline });
    if (!res.ok) return null;
    const channels = await res.json();
    const isGeneral = (c) => c.type === 0 && c.name === "general";
    let candidates;
    if (section) {
      const sectionCategories = new Set(
        channels
          .filter((c) => c.type === 4)
          .filter((c) =>
            (c.permission_overwrites || []).some(
              (o) => o.id === section.role_id && (BigInt(o.allow || "0") & VIEW_CHANNEL) !== 0n
            )
          )
          .map((c) => c.id)
      );
      candidates = channels.filter((c) => isGeneral(c) && sectionCategories.has(c.parent_id));
    } else {
      candidates = channels.filter(isGeneral);
    }
    candidates.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return candidates[0]?.id ?? null;
  } catch (err) {
    console.error("findGeneralChannel:", err);
    return null;
  }
}

function failureMessage(status) {
  if (status === 403) {
    return "⚠️ I don't have permission to do that. Please tell your instructor to move my role above the Student and section roles.";
  }
  if (status === 400 || status === 404) {
    return "I couldn't give you your class roles. They may have been changed or deleted. 😿 Please let your instructor know.";
  }
  return "Discord is busy or having trouble right now. 😿 Please try registering again in a minute.";
}

// ===========================================================================
// The registration panel
// ===========================================================================
function buttonRows(buttons) {
  const rows = [];
  for (let k = 0; k < buttons.length; k += 5) rows.push({ type: 1, components: buttons.slice(k, k + 5) });
  return rows;
}

const IMPORTANT_COLOR = 0xfacc15; // yellow edge for the "Important" box

/**
 * Two boxes: the steps (orange edge) and the must-read rules (yellow edge).
 * Discord can't color text or enlarge normal text, so every line students must
 * act on is a heading, and everything else is kept short.
 * style: "welcome" for new servers, "reregister" for servers whose members are re-registering.
 */
export function buildPanel(server, sections, instructorId, hasList = false, style = "welcome", instructorName = "") {
  // With a class list, students don't pick a section: Mingming looks it up
  const shown = hasList ? [] : sections.slice(0, MAX_SECTIONS);
  const buttons = hasList
    ? [button("Register", "reg:list")]
    : shown.length
      ? shown.map((s) => button(s.label, `reg:${s.role_id}`, s.emoji))
      : [button("Register", "reg:none")];
  const sectioned = sections.length > 0;
  // A tappable mention of the instructor. (Phone apps may show it as the username,
  // e.g. @their.username, instead of the server nickname; Discord controls that.)
  const instructor = instructorId ? `your instructor, <@${instructorId}>` : "your instructor";
  const again = style === "reregister";

  const step1 = shown.length ? "Click **your section's** button below" : "Click **Register** below";
  const steps =
    (again
      ? `## 📋 Re-register for ${server.course_name}\n` +
        "We're tidying up the server so everyone's name is uniform and easy for your instructor to find. It takes about a minute.\n"
      : `## 🐾 Welcome to ${server.course_name}!\n` +
        "Before you can see the class channels, please register with **Mingming** 🐱, the class bot. It takes about a minute.\n") +
    `### 1️⃣ ${step1}\n` +
    "### 2️⃣ Type your complete name and email\n" +
    (again
      ? (hasList && sectioned
          ? "That's it! Mingming will update your name in this server and put you in your correct section."
          : "That's it! Mingming will update your name in this server.")
      : hasList && sectioned
        ? "That's it! Mingming will put you in your section and open your class channels."
        : "That's it! Your class channels will open right after.");

  // (The "complete name, not a nickname" reminder lives in the form's First Name field)
  let rules = shown.length ? "### ⚠️ Choose your section carefully\nOnly your instructor can change it later.\n" : "";
  rules +=
    "### 📧 Use an email you actually check\n" +
    "Your instructor may email you about grades.\n\n" +
    `Made a mistake or have questions? Message ${instructor}. Only your instructor can download your email.`;

  return {
    embeds: [
      { description: steps.slice(0, 4096), color: PANEL_COLOR },
      { description: rules.slice(0, 4096), color: IMPORTANT_COLOR },
    ],
    components: buttonRows(buttons),
  };
}

function button(label, customId, emoji) {
  return { type: 2, style: 1, label, emoji: { name: emoji || "🐾" }, custom_id: customId };
}

/** One standard emoji (including multi-part ones like flags or skin tones). */
export function isSingleEmoji(text) {
  if (text.length > 16 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200D|\uFE0F)+$/u.test(text)) return false;
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)];
  return graphemes.length === 1;
}

function textInput(id, label, placeholder, maxLength, required = true) {
  return {
    type: 1,
    components: [{ type: 4, custom_id: id, label, style: 1, placeholder, required, max_length: maxLength }],
  };
}

// ===========================================================================
// Database helpers
// ===========================================================================
async function getServer(env, guildId) {
  return env.DB.prepare("SELECT * FROM servers WHERE guild_id = ?1").bind(guildId).first();
}

/** Current (active) sections, shown on the panel */
async function getSections(env, guildId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sections WHERE guild_id = ?1 AND active = 1 ORDER BY label COLLATE NOCASE"
  )
    .bind(guildId)
    .all();
  return results;
}

async function getSection(env, guildId, roleId) {
  return env.DB.prepare("SELECT * FROM sections WHERE guild_id = ?1 AND role_id = ?2 AND active = 1")
    .bind(guildId, roleId)
    .first();
}

/** Every section role this server has ever used, including retired ones */
async function getAllSectionRoleIds(env, guildId) {
  const { results } = await env.DB.prepare("SELECT role_id FROM sections WHERE guild_id = ?1")
    .bind(guildId)
    .all();
  return results.map((r) => r.role_id);
}

/**
 * A student counts as registered only if they have BOTH the Student role
 * and a saved roster entry. Missing either one (e.g., the instructor removed
 * the role, the roster was cleared, or a save failed) lets them register again.
 */
async function isRegistered(env, guildId, userId, roles, server) {
  if (!roles.includes(server.student_role_id)) return false;
  const row = await env.DB.prepare("SELECT 1 FROM students WHERE guild_id = ?1 AND user_id = ?2")
    .bind(guildId, userId)
    .first();
  return Boolean(row);
}

async function claimLock(env, guildId, userId) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM in_progress WHERE guild_id = ?1 AND user_id = ?2 AND started_at < ?3")
    .bind(guildId, userId, now - LOCK_SECONDS)
    .run();
  const result = await env.DB.prepare(
    "INSERT INTO in_progress (guild_id, user_id, started_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING"
  )
    .bind(guildId, userId, now)
    .run();
  return result.meta.changes === 1;
}

async function releaseLock(env, guildId, userId) {
  await env.DB.prepare("DELETE FROM in_progress WHERE guild_id = ?1 AND user_id = ?2").bind(guildId, userId).run();
}

// ===========================================================================
// Other helpers
// ===========================================================================
function isDangerousRole(role) {
  return role ? (BigInt(role.permissions ?? "0") & DANGEROUS_PERMISSIONS) !== 0n : false;
}

const DANGEROUS_ROLE_TEXT =
  "That role has staff powers (like Administrator, Manage Roles, or Kick Members), so students must never get it. " +
  "Please pick a regular role, or remove those permissions from it first.";

function isInstructor(i) {
  const perms = BigInt(i.member?.permissions ?? "0");
  return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
}

// Mixed case is only kept when it follows a real naming pattern, e.g. McArthur, MacDonald, DeLeon
const INTENTIONAL_MIXED_CASE = /^(Mc|Mac|De|Del|Dela|Di|Da|La|Le|Van|Von)\p{Lu}\p{Ll}+$/u;

function tidyPart(part) {
  if (!part || INTENTIONAL_MIXED_CASE.test(part)) return part;
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Proper capitalization no matter how it was typed: "JUAN", "juan", and "jUaN" all
 * become "Juan". Hyphenated and apostrophe names are handled per part ("o'NEIL" ->
 * "O'Neil", "santos-REYES" -> "Santos-Reyes"), and intentional patterns like
 * "McArthur" or "DeLeon" are kept.
 */
export function tidyName(raw) {
  return raw
    .replace(/[\u2018\u2019\u02BC]/g, "'") // curly apostrophes from phone keyboards
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.split(/([-'])/).map(tidyPart).join(""))
    .join(" ");
}

/** Jr./Sr./roman numerals in a standard form; "" if blank; null if not a recognized suffix. */
export function tidySuffix(raw) {
  const s = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!s) return "";
  if (s === "jr") return "Jr.";
  if (s === "sr") return "Sr.";
  if (/^(i{1,3}|iv|v|vi{1,3}|ix|x)$/.test(s)) return s.toUpperCase();
  return null;
}

const MAX_NICKNAME = 32; // Discord's limit

/**
 * Nickname with the middle initial, e.g. "Juan M. Dela Cruz Jr." or, in Philippine
 * records style, "Dela Cruz, Juan Jr. M.". If it's longer than Discord's 32-character
 * limit, given names are turned into initials from the end (whole names only), keeping as
 * many in full as fit and always keeping the last name, suffix, and middle initial.
 * Returns { nick, shortened }.
 */
export function buildNickname(format, { first, middle, last, suffix }) {
  const mi = middle ? `${middle.charAt(0).toUpperCase()}.` : "";
  const given = first.split(" ").filter(Boolean);
  const make = (givenPart, withMi = true) =>
    format === "last_first"
      ? `${last}, ${[givenPart, suffix, withMi ? mi : ""].filter(Boolean).join(" ")}`
      : [givenPart, withMi ? mi : "", last, suffix].filter(Boolean).join(" ");

  const full = make(given.join(" "));
  if (full.length <= MAX_NICKNAME) return { nick: full, shortened: false };

  // 1. Keep as many given names in full as fit; the rest become initials
  //    e.g. "Ana Isabella Rosalie Victoria" -> "Ana Isabella R. V."
  const initial = (name) => `${name.charAt(0).toUpperCase()}.`;
  for (let k = given.length - 1; k >= 1; k--) {
    const nick = make([...given.slice(0, k), ...given.slice(k).map(initial)].join(" "));
    if (nick.length <= MAX_NICKNAME) return { nick, shortened: true };
  }
  // 2. Very long surnames: first given name as an initial, then without the middle initial
  for (const nick of [make(`${given[0].charAt(0)}.`), make(`${given[0].charAt(0)}.`, false)]) {
    if (nick.length <= MAX_NICKNAME) return { nick, shortened: true };
  }
  // 3. Last resort: cut, and show that it was cut
  return { nick: full.slice(0, MAX_NICKNAME - 1).trimEnd() + "…", shortened: true };
}

/** Letters plus spaces, periods, hyphens, apostrophes; at least 1 letter. */
export function isValidName(name) {
  return /\p{L}/u.test(name) && /^[\p{L}\p{M} .'\-]+$/u.test(name);
}

/** Quote a CSV cell, and block spreadsheet formula injection (cells starting with = + - @). */
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "class";
}

async function withRetries(fn, attempts = 3) {
  for (let k = 1; k <= attempts; k++) {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`Attempt ${k} failed:`, err);
      if (k < attempts) await sleep(300 * k);
    }
  }
  return false;
}

const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const reply = (content) => json({ type: MESSAGE, data: { content, flags: EPHEMERAL } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call Discord's API with a timeout. Retries short rate limits (429), temporary
 * server errors (5xx), and network errors. If Discord asks us to wait longer than
 * MAX_RETRY_WAIT_SECONDS, we stop and return the response so the student can be
 * told to try again later (background work on Cloudflare is limited to ~30 seconds).
 */
async function discord(env, path, options = {}, { attempts = 1, auth = true, deadline = Infinity } = {}) {
  const base = env.DISCORD_API_BASE || DEFAULT_API;
  const timeLeft = () => deadline - Date.now();
  for (let attempt = 1; ; attempt++) {
    if (timeLeft() <= 0) throw new Error("Out of time for this registration");
    const headers = { ...(options.headers || {}) };
    if (auth) headers.Authorization = `Bot ${env.DISCORD_TOKEN}`;
    if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeLeft()));

    let res;
    try {
      res = await fetch(base + path, { ...options, headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      const pause = 500 * attempt;
      if (attempt < attempts && timeLeft() > pause) {
        await sleep(pause);
        continue;
      }
      throw err;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      let wait = 1;
      try {
        wait = Number((await res.clone().json()).retry_after ?? 1);
      } catch {}
      const pause = wait * 1000 + 250;
      if (wait > MAX_RETRY_WAIT_SECONDS || timeLeft() <= pause) return res;
      await sleep(pause);
      continue;
    }
    return res;
  }
}

/** Verify that a request was signed by Discord (required by Discord). */
async function verifySignature(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
  return bytes;
}
