/**
 * Registers Mingming's instructor slash commands with Discord.
 * Run this once after setup, and again only if the commands change:
 *
 *   npm run register
 *
 * It asks for your Application ID and bot token. The token is hidden as you
 * paste it and is never saved in your Terminal history.
 */

import readline from "node:readline";

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
        else if (!/\r|\n/.test(text)) rl.output.write("*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID || (await ask("Application ID: "));
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || (await ask("Bot token (hidden): ", { hidden: true }));
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("Missing Application ID or bot token. See README Step 7.");
  process.exit(1);
}

const STRING = 3;
const USER = 6;
const ROLE = 8;
const ATTACHMENT = 11;
const INSTRUCTORS_ONLY = "32"; // "Manage Server" permission
const SERVERS_ONLY = [0];

const commands = [
  {
    name: "setup",
    description: "Set this server's course name and Student role",
    options: [
      { type: STRING, name: "course_name", description: "e.g., Data Structures and Algorithms", required: true, max_length: 100 },
      { type: ROLE, name: "student_role", description: "The role every registered student gets", required: true },
      {
        type: STRING,
        name: "name_format",
        description: "How student nicknames look (default: First Last)",
        required: false,
        choices: [
          { name: "First Last (Juan Dela Cruz)", value: "first_last" },
          { name: "Last, First (Dela Cruz, Juan)", value: "last_first" },
        ],
      },
    ],
  },
  {
    name: "add-section",
    description: "Add a section (or rename one) on the registration panel",
    options: [
      { type: ROLE, name: "role", description: "The section's role, e.g., BSIT 2A", required: true },
      { type: STRING, name: "label", description: "Button text (default: the role's name)", required: false, max_length: 80 },
      { type: STRING, name: "emoji", description: "Emoji on the button, e.g. 🟡 (default: 🐾)", required: false, max_length: 16 },
    ],
  },
  {
    name: "remove-section",
    description: "Remove a section from the registration panel",
    options: [{ type: ROLE, name: "role", description: "The section's role", required: true }],
  },
  { name: "settings", description: "Show this server's Mingming settings" },
  {
    name: "post-register",
    description: "Post the registration panel in this channel",
    options: [{
      type: STRING, name: "style", description: "Wording of the panel (default: Welcome)", required: false,
      choices: [
        { name: "Welcome (new server)", value: "welcome" },
        { name: "Re-registration (students already in the server)", value: "reregister" },
      ],
    }],
  },
  { name: "export-roster", description: "Download the registered students (names, sections, emails) as a CSV file" },
  {
    name: "import-classlist",
    description: "Upload a class list (CSV) so Mingming can verify students and assign their section",
    options: [{ type: ATTACHMENT, name: "file", description: "CSV with Last Name, First Name, M.I., Ext., Section (and ID No.)", required: true }],
  },
  { name: "unregistered", description: "List students on the class list who haven't registered yet (as a CSV file)" },
  {
    name: "retire-role",
    description: "Mark an old role to be removed automatically when each student registers",
    options: [{ type: ROLE, name: "role", description: "The old role, e.g. a section role from another bot", required: true }],
  },
  {
    name: "reset-student",
    description: "Reset one student so they can register again from scratch",
    options: [{ type: USER, name: "student", description: "The student to reset", required: true }],
  },
  {
    name: "clear-roster",
    description: "Erase this server's saved names and emails (e.g., before reusing it next semester)",
    options: [{ type: STRING, name: "confirm", description: "Type DELETE to confirm", required: true }],
  },
].map((c) => ({ ...c, default_member_permissions: INSTRUCTORS_ONLY, contexts: SERVERS_ONLY }));

const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

if (res.ok) {
  console.log(`✅ Registered ${commands.length} commands. They may take a minute to appear in Discord. 🐱`);
} else {
  console.error(`❌ Failed (${res.status}):`, await res.text());
  process.exit(1);
}
