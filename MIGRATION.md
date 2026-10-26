# Moving ITC 120 and IT 110 to Mingming (this semester)

Goal: tidy nicknames, collect emails, and put every ITC 120 student in the section your class list says, **without cutting anyone off from your announcements**.

How it works once done:

- **The Register panel lives in `#welcome`.** Your pinned @everyone announcement in the course `#announcements` (the channel students actually check) links straight to it.
- **Unregistered students** (everyone, at first) keep seeing everything you post in: the course channels and their section's `#announcements`. Your pings keep reaching them. Only their section's `#general` waits until they register.
- When they register, Mingming finds them on your class list, gives them the **correct** section role (with color), sets their nickname, and removes their old role.
- Your member list sorts itself: **colored names = registered and verified**, gray names = not registered yet.
- **Nobody ever loses access.** Students who don't register keep receiving everything; you nudge them with reminders instead.

Do **Part 1 once**, then Part 2 for ITC 120 and Part 3 for IT 110. Each server takes about 30 to 45 minutes.

**Names used below:** this guide calls the section categories "IT 2C" and so on. If yours are named differently (for example "BSIT 2C"), that's fine; category names don't matter.

---

## Part 1: Update Mingming (once, on your Mac)

1. **Copy in the new files.** Unzip `mingming-update.zip`, open the unzipped **mingming-update** folder, press **Command + A**, and drag everything into your **mingming** folder (the one with `node_modules` and `wrangler.toml`). Choose **Replace** for everything.
2. **Update the database** (only once, ever; running it again just shows "duplicate column" errors). In Terminal, inside the `mingming` folder:
   ```
   npx wrangler d1 execute mingming-db --remote --command "$(cat migrations/2026-10-class-list.sql)"
   ```
   Type **y** if asked. To confirm: `npx wrangler d1 execute mingming-db --remote --command "PRAGMA table_info(students)"` should list **student_id**, **on_list**, and **list_name** at the end.
3. **Deploy:** `npm run deploy` → should show **Total Upload: 57.14 KiB / gzip: 16.06 KiB**.
4. **Register the commands:** `npm run register` → paste your Application ID and bot token when asked → must say **Registered 11 commands**.
5. In Discord, press **Command + R**. Typing `/` in any server with Mingming should now show `/import-classlist`, `/unregistered`, and `/retire-role`.

Keep the class list CSV files **outside** the `mingming` folder, next to your token note. They contain student names and IDs, so don't share them with other tools or people.

---

## Part 2: ITC 120 server

### 2.1 Invite Mingming

1. Go to https://discord.com/developers/applications → click **Mingming** → **OAuth2** (left sidebar) → **OAuth2 URL Generator**.
2. **Scopes:** check `bot` and `applications.commands`.
3. **Bot Permissions:** check **Manage Roles**, **Manage Nicknames**, **View Channels**, **Send Messages**, and **Embed Links**.
4. Copy the **Generated URL** at the bottom, open it in your browser, choose the **ITC 120** server, and click **Authorize**.

Mingming now appears in the server, with its own role named **Mingming**.

↩ *Setting up IT 110? [Back to 3.1](#31-mingming)*

### 2.2 Roles

Go to **Server Settings → Roles**. Each role has a **Display** tab (name, color, "Display role members separately," "Allow anyone to @mention this role," and the **View Server As Role** button) and a **Permissions** tab (with a **Clear permissions** link at the top right).

1. **Your current section roles** (BSIT 2C, 2D, 2E, 2F). For each one:
   - **Display tab:** rename it to **2C (unregistered)** (and 2D, 2E, 2F accordingly), set the color to the **default gray**, turn **Display role members separately OFF**, and turn **Allow anyone to @mention this role OFF**.
   - **Permissions tab:** click **Clear permissions**.
   - Click **Save Changes**. Renaming keeps every student in their role, so nobody loses access.
2. **Create four new section roles** (click **Create Role**): **BSIT 2C** (blue), **BSIT 2D** (green), **BSIT 2E** (purple), **BSIT 2F** (red). For each one:
   - **Display tab:** name and color as above, **Display role members separately ON**, **Allow anyone to @mention this role OFF**.
   - **Permissions tab:** click **Clear permissions**. This matters: new roles can start with some permissions already ON (such as Change Nickname), which would let students rename themselves, and if any staff-level permission is on, Mingming refuses the role in `/add-section`.
   - Click **Save Changes**.
3. **Create a Student role:** **Display tab:** name **Student**, default gray color, Display separately **OFF**, @mention **OFF**. **Permissions tab:** **Clear permissions**. **Save Changes**.
4. **Mingming's role:** **Display tab** → **Display role members separately ON** → **Save Changes**. This lists Mingming in its own group right below you in the member list (otherwise it sits under "Online").
5. **Don't use a "Test Account" role.** A test account with no extra roles behaves exactly like a real student. If you have one, delete it.
6. **Role order** (drag roles in the list), top to bottom:
   1. Instructor
   2. Mingming (it can only rename and give roles to members whose roles are **below** it)
   3. BSIT 2C, BSIT 2D, BSIT 2E, BSIT 2F
   4. 2C, 2D, 2E, 2F (unregistered)
   5. Student
   6. carl-bot (if it's still in the server)
   7. @everyone (always last)

↩ *Setting up IT 110? [Back to 3.2](#32-roles)*

### 2.3 Channels

**Layout** (moving channels keeps their messages):

```
🔒 INSTRUCTOR      welcome-test, bot-commands, join-log, test
📌 START HERE      welcome
📚 ITC 120         announcements, coursework, course-resources
🔵 IT 2C           announcements, general      (same for 2D, 2E, 2F)
```

1. Create the **INSTRUCTOR** category (click the server name at the top left → **Create Category**) with `#test` (move it there), and three new text channels: `#welcome-test` (a private copy of `#welcome` for testing; you delete it after 2.7), `#bot-commands`, and `#join-log`.
2. Point the system messages to the new channel: **Server Settings → Engagement → System Messages Channel → `#join-log`**. If your server has Community enabled, also set **Server Settings → Community → Overview → Community Updates Channel → `#join-log`**. (Discord won't delete a channel that's still set there.)
3. **Delete** the unused channels: each section's `#shared-resources` and voice channel, and `#server-notices` (its only post is the old Carl-bot instructions).
4. Delete or unpin any other old Carl-bot instructions in `#announcements`. **Leave Carl-bot's welcome message in `#welcome` for now**; you'll delete it in 2.7 (Go live), right after Mingming's panel is up, so `#welcome` is never empty.

#### How to set permissions

Right-click a category → **Edit Category** → **Permissions**. For a single channel, hover over it → ⚙️ **Edit Channel** → **Permissions**. Click **+** next to Roles/Members to add a role (or a member). Leave every permission not listed on **/** (neutral), and click **Save Changes** after each one. Some entries may already exist from your Carl-bot setup; just adjust them to match.

**Sync** means: open the channel's ⚙️ → **Permissions**; if it says it isn't synced with its category, click **Sync Now**, so it copies the category's entries. A channel that isn't synced ignores its category's entries, which is how Mingming ends up with "Discord error 403" (no permission to post).

**Note on names:** in **category** settings, Discord uses longer names: **Send Messages** appears as **Send Messages and Create Posts**, and **Send Messages in Threads** appears as **Send Messages in Threads and Posts**. They're the same permissions.

Do the rows **in this order**:

| Category / channel | Permission entries |
|---|---|
| 🔒 **INSTRUCTOR** (category) | **Private Category** ON, no roles added |
| └ #bot-commands, #test | Sync |
| └ #join-log | Sync, then add **Mingming:** View Channel ✅, Send Messages ✅. Mingming posts here and **@mentions you** whenever a registration needs your review (not on the class list, or name spelled differently) |
| └ #welcome-test | Sync, then add **Mingming:** View Channel ✅, Send Messages ✅, Embed Links ✅ · and each **test account** (the member itself): View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ |
| 📌 **START HERE** (category) | **@everyone:** View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ · **Mingming:** View Channel ✅, Send Messages ✅, Embed Links ✅ · *(optional)* **Student:** View Channel ❌ (hides `#welcome` once a student registers) |
| └ #welcome | Sync, then click **Mingming** in its Roles/Members list and check the three ✅ above. (Read Message History may also show ✅; that's fine) |
| 📚 **ITC 120** (category) | **@everyone:** View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ (everyone, registered or not, can read and get your pings) |
| └ its channels | Sync |
| 🔵 **IT 2C** (category) | **Private Category** ON · **@everyone:** Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ · **2C (unregistered):** View Channel ✅ · **BSIT 2C:** View Channel ✅ |
| └ #announcements | Sync (both roles can read; only you post) |
| └ #general | **Do not sync.** **Custom:** select **2C (unregistered)** and set its **View Channel ❌**. **BSIT 2C:** View Channel ✅, Send Messages ✅, Send Messages in Threads ✅, Create Public Threads ✅, Mention @everyone, @here, and All Roles ✅ |

Repeat the section rows for 2D, 2E, 2F with their own roles. Keep each section chat named exactly **`general`**, so Mingming can link students to it after they register.

↩ *Setting up IT 110? [Back to 3.3](#33-channels)*

### 2.4 Server-wide @everyone

Go to **Server Settings → Roles → Default Permissions** (the **@everyone** entry). Do this **after 2.3**, since the category permissions from 2.3 are what keep the right channels visible.

**Turn these ON** (normal participation):

- Send Messages and Create Posts, Send Messages in Threads and Posts, Create Public Threads, Read Message History
- Embed Links, Attach Files, Add Reactions, Use External Emoji, Use External Stickers
- Connect, Speak, Video, Use Voice Activity
- Use Application Commands
- Optional: Create Polls, Send Voice Messages, Use Activities

**Turn these OFF:**

- **Staff powers:** Administrator, Manage Channels, Manage Roles, Manage Server, Manage Webhooks, View Audit Log, Manage Nicknames, Manage Messages, Manage Threads and Posts, Manage Expressions, Manage Events
- **Moderation:** Kick, Approve, and Reject Members; Ban Members; Timeout Members; Mute Members; Deafen Members; Move Members
- **Disruptive or unnecessary:** Mention @everyone, @here, and All Roles; Create Invite; Pin Messages; Bypass Slowmode; Send Text-to-Speech Messages; Use Soundboard; Use External Sounds; Priority Speaker; Set Voice Channel Status; Create Private Threads; Create Expressions; Create Events; Use External Apps
- **Change Nickname** (from now on, only Mingming sets names)
- **View Channels:** turn this OFF **as the very last click** of this section, then **Save Changes**

**Check it:** Server Settings → Roles → click **2E (unregistered)** → **Display** tab → scroll to the bottom → **View Server As Role**. You should see START HERE, ITC 120, and IT 2E's `#announcements`, but **not** IT 2E's `#general`. Exit with the banner at the top of the screen. If important channels are missing, turn View Channels back ON for @everyone and recheck 2.3.

↩ *Setting up IT 110? [Back to 3.4](#34-server-wide-everyone)*

### 2.5 Server settings

- **Server Settings → Engagement → System Messages Channel:** `#join-log` (done in 2.3). Turn **Prompt members to reply to welcome messages with a sticker** OFF.
- **Default Notification Settings** (on the **Engagement** page, or **Overview** in some Discord versions): **Only @mentions**.

↩ *Setting up IT 110? [Back to 3.5](#35-server-settings)*

### 2.6 Set up Mingming

Type these in `#bot-commands`:

1. `/setup` → course_name `ITC 120: Data Structures and Algorithms`, student_role **Student**, name_format **Last, First**.
2. `/add-section` four times, picking the **new** roles (not the "(unregistered)" ones): **BSIT 2C** with emoji 🔵, **BSIT 2D** 🟢, **BSIT 2E** 🟣, **BSIT 2F** 🔴.
3. `/retire-role` four times: **2C (unregistered)**, **2D (unregistered)**, **2E (unregistered)**, **2F (unregistered)**.
4. Don't import the real class list yet; the test in 2.7 uses a copy first.

### 2.7 Test, then go live

Test in the private `#welcome-test`, so real students never see the test panel. You'll test both paths: a student **on** the class list (test account #1) and one **not** on it (test account #2). Both test accounts need to be in the ITC 120 server, with access to `#welcome-test` (2.3).

1. **Make a test copy of the class list** (don't edit the real file): in Finder, right-click `ITC120_classlist.csv` → **Duplicate**. Right-click the copy → **Open With** → **TextEdit**. Click at the very end of the last line, press **Return**, and type exactly:
   ```
   TEST-1,TEST,STUDENT ONE,,,IT2E
   ```
   Save (**Command + S**) and close TextEdit.
2. In `#bot-commands`: `/import-classlist` → attach the **copy**. It should report **155 students**.
3. In `#welcome-test`: `/post-register` → style **Re-registration**. You should see a single **Register** button. If it says "Discord error 403", recheck the `#welcome-test` row in 2.3.
4. Test:

   | Test account | Do this | Expect |
   |---|---|---|
   | #1 | Right-click it → **Roles** → give it **2C (unregistered)**. Then, as that account, register in `#welcome-test` with First Name **Student One**, Last Name **Test**, and any email | Placed in **BSIT 2E** (from the list, not 2C), "(unregistered)" role removed, nickname **Test, Student One**, and it can now see IT 2E's `#general` |
   | #2 | Register in `#welcome-test` with a made-up name (e.g., **Juan Tester**) and any email | Mingming says it couldn't find them and shows section buttons. After picking one, they're registered, flagged **NO - please check** in `/export-roster`, and **`#join-log` pings you** (no ping? recheck the `#join-log` row in 2.3) |

5. **Clean up:** `/reset-student` on both test accounts, then `/import-classlist` with the **real** `ITC120_classlist.csv` (it replaces the test copy; should report **154 students (2C: 41, 2D: 42, 2E: 35, 2F: 36)**). Delete the CSV copy from your Mac.
6. **Go live:** in `#welcome`, run `/post-register` → style **Re-registration** (wording for students already in the server). If it says "Discord error 403", recheck the START HERE and `#welcome` rows in 2.3. Then delete `#welcome-test`.
7. **Right after the panel appears**, clean up `#welcome`:
   - **Delete Carl-bot's old welcome message** (hover over it → **⋯** → **Delete Message**). This also switches off its reaction roles, so students can't pick a section by reacting anymore.
   - **Update the channel topic:** click the ⚙️ next to `#welcome` → **Channel Topic**, and replace "Select your officially enrolled section..." with something like: *Click **Register** below to set your name and unlock your class channels.* → **Save Changes**.
   - If you don't use Carl-bot for anything else, you can kick it (right-click Carl-bot in the member list → **Kick**).

### 2.8 Registrations that need your review

Whenever a student registers but **isn't on the class list**, or their **name is spelled differently** from it, Mingming posts in `#join-log` and **@mentions you**, so you get a notification. (This uses the System Messages Channel from 2.3, and the Mingming permission entry on `#join-log`.) Normal registrations don't ping you.

### About registrar misspellings

The registrar's list sometimes misspells names. Mingming uses the list to **find** students and **assign their section**, but when a student's spelling (or middle initial) really differs from the list, it **keeps the student's version** and:

- tells the student privately, showing **both spellings**: if they made a typo, they should message you; if their spelling is correct, they should have the school record corrected at the **Registrar's Office** (their adviser can guide them), since it can affect their transcript and diploma
- marks them **"Yes, but name differs"** in `/export-roster`, with the registrar's version in the **Class List Spelling** column

Review those rows: student typos can be fixed with `/reset-student`; the rest are likely registrar errors the student may not know about.

**Students who dropped the course:** remove their row from the class list CSV, `/import-classlist` it again, and kick them from the server if they're in it. If they try to register later, Mingming won't find them and pings you in `#join-log`.

### 2.9 Announce it

1. **Inside the server:** post in ITC 120 `#announcements` with **@everyone**. Type `#welcome` and pick it from the suggestions so it becomes a **clickable link**, then **pin** the message. Keep it short, for example:

   > ## 🧹 Please Re-register
   > Hi, @everyone. Kindly click **Register** in #welcome.
   >
   > Also, some of your classmates still haven't joined the server. If you're in touch with them on Messenger or anywhere else, please send them this 👇
   > https://discord.gg/your-invite-code

2. **Attach the poster** (`ITC_120_Discord_Announcement.png`) to that post, and share it in your class group chats too. Keep your invite link (**Invite People** under the server name) as **text** next to it, so it's tappable (text in an image isn't).

↩ *Setting up IT 110? [Back to 3.8](#38-announce)*

### 2.10 Register in class

Registering in class is the most effective step. Give each section about five minutes at the start of one meeting to register on their phones. Watch progress live with `/settings` in `#bot-commands` (registered count vs. class list size).

↩ *Setting up IT 110? [Back to 3.8](#38-announce)*

### 2.11 Nudge the stragglers

There's no deadline and nobody loses access, so stragglers just need reminders:

- **Who's left?** Run **`/unregistered`** in `#bot-commands`. It attaches a CSV of everyone on your class list who hasn't registered yet, by section, **including students who haven't joined the server at all**. (In the member list, unregistered students in the server also show as gray names.)
- **Remind them personally:** @mention the remaining students in an announcement now and then (each gets a personal notification), or read the list out in class. Students not yet in the server need the invite link.
- They keep receiving all your announcements in the meantime, so nothing is missed while they get around to it.

↩ *Setting up IT 110? [Back to 3.8](#38-announce)*

---

## Part 3: IT 110 server

IT 110 is simpler than ITC 120: it has **one section**, no old section role, and no Carl-bot, and everyone could see every channel before. So you add **one role, BSIT 1A**, that marks registered students. Registering unlocks `#general`; every other channel stays visible to everyone the whole time, so nobody loses your announcements.

In this server, **BSIT 1A is Mingming's "student role"** (the role it gives everyone who registers). Wherever Mingming or the README says "Student role", it means BSIT 1A here.

**Starting point:** roles **Instructor** and **Mingming**; channels `#test`, **START HERE** (`#welcome`, `#announcements`, `#coursework`, `#course-resources`, `#server-notices`), and **IT 1A** (`#general`, `#shared-resources`, and the **IT 1A** voice channel).

### 3.1 Mingming

Mingming is already in the server (it has a role named **Mingming**). If it ever isn't, invite it as in [2.1](#21-invite-mingming).

### 3.2 Roles

Go to **Server Settings → Roles** (the Display and Permissions tabs are described in [2.2](#22-roles)).

1. **Create the BSIT 1A role:** click **Create Role**.
   - **Display tab:** name **BSIT 1A**, pick a **color**, turn **Display role members separately ON**, and **Allow anyone to @mention this role OFF**.
   - **Permissions tab:** **Clear permissions**.
   - **Save Changes**.
2. **Mingming's role:** **Display tab** → **Display role members separately ON** → **Save Changes** (lists Mingming right below you in the member list).
3. **Don't use a "Test Account" role;** delete it if you have one. A test account with no extra roles behaves exactly like a real student.
4. **Role order** (drag roles in the list), top to bottom:
   1. Instructor
   2. **Mingming** (it can only rename and give roles to members whose roles are **below** it)
   3. BSIT 1A
   4. @everyone (always last)

There's no "(unregistered)" role here, so there's no `/retire-role` either. Unregistered students are simply the ones without the BSIT 1A role (gray names).

### 3.3 Channels

**Final layout:**

```
🔒 INSTRUCTOR     welcome-test, bot-commands, join-log, test
📌 START HERE     welcome
🟡 BSIT 1A        announcements, coursework, course-resources, general
```

1. **INSTRUCTOR category:** click the server name at the top left → **Create Category** → name it **INSTRUCTOR**, turn **Private Category** ON, add no roles. Move `#test` into it, and create three text channels inside it: `#welcome-test`, `#bot-commands`, and `#join-log`.
2. **Rename the IT 1A category to BSIT 1A** (optional) and **move** `#announcements`, `#coursework`, and `#course-resources` into it, so `#welcome` is alone in START HERE.
3. **Server Settings → Engagement → System Messages Channel → `#join-log`**. If Community is enabled, also set **Server Settings → Community → Overview → Community Updates Channel → `#join-log`**.
4. *(Optional)* Delete what you don't use: `#shared-resources`, the **IT 1A** voice channel, and `#server-notices` (check its posts first).

**Permissions:** see [How to set permissions](#how-to-set-permissions) for where to click, what **Sync** means, and the "Note on names". Do the rows **in this order**:

| Category / channel | Permission entries |
|---|---|
| 🔒 **INSTRUCTOR** (category) | **Private Category** ON, no roles added |
| └ #bot-commands, #test | Sync |
| └ #join-log | Sync, then add **Mingming:** View Channel ✅, Send Messages ✅ |
| └ #welcome-test | Sync, then add **Mingming:** View Channel ✅, Send Messages ✅, Embed Links ✅ · and your **test account** (the member itself): View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ |
| 📌 **START HERE** (category) | **@everyone:** View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ · **Mingming:** View Channel ✅, Send Messages ✅, Embed Links ✅ |
| └ #welcome | Sync, then click **Mingming** in its Roles/Members list and check the three ✅ above. (Read Message History may also show ✅; that's fine) |
| 🟡 **BSIT 1A** (category) | **@everyone:** View Channel ✅, Read Message History ✅, Send Messages ❌, Send Messages in Threads ❌, Create Public Threads ❌, Create Private Threads ❌ (everyone reads; only you post) |
| └ #announcements, #coursework, #course-resources | Sync |
| └ #general | **Do not sync.** **Custom:** **@everyone:** View Channel ❌ · **BSIT 1A:** View Channel ✅, Read Message History ✅, Send Messages ✅, Send Messages in Threads ✅, Create Public Threads ✅, Mention @everyone, @here, and All Roles ✅ |

Keep the section chat named exactly **`general`**, so Mingming can link students to it after they register.

**What students see:** unregistered, `#welcome` plus BSIT 1A's `#announcements`, `#coursework`, and `#course-resources` (read-only); registered, the same plus `#general`, where they can chat.

### 3.4 Server-wide @everyone

Use the ON/OFF lists in [2.4](#24-server-wide-everyone), with one difference: **leave View Channels ON**. There's only one section, so nothing needs hiding server-wide; `#general` is already hidden by its own entry in 3.3. The most important switch is **Change Nickname OFF**.

### 3.5 Server settings

As in [2.5](#25-server-settings).

### 3.6 Set up Mingming

Type these in `#bot-commands`:

1. `/setup` → course_name `IT 110: Introduction to Computing`, student_role **BSIT 1A**, name_format **Last, First**.
2. **No** `/add-section` and **no** `/retire-role`.
3. Don't import the real class list yet; the test in 3.7 uses a copy first.

### 3.7 Test, then go live

Test in the private `#welcome-test`, so real students never see the test panel.

1. **Make a test copy of the class list** (don't edit the real file): in Finder, right-click `IT110_classlist.csv` → **Duplicate**. Right-click the copy → **Open With** → **TextEdit**. Click at the very end of the last line, press **Return**, and type exactly:
   ```
   TEST-2,TEST,STUDENT TWO,,,IT1A
   ```
   Save (**Command + S**) and close TextEdit.
2. In `#bot-commands`: `/import-classlist` → attach the **copy**. It should report **44 students**.
3. In `#welcome-test`: `/post-register` → style **Re-registration**. You should see a single **Register** button. If it says "Discord error 403", recheck the `#welcome-test` row in 3.3.
4. **Test 1, on the list:** as your test account, open `#welcome-test`. At the bottom it should say "You do not have permission to send messages in this channel" (not "threads only"). Click **Register** and enter First Name **Student Two**, Last Name **Test**, and any email. Expect: nickname **Test, Student Two**, the **BSIT 1A** role, and `#general` now visible.
5. **Test 2, not on the list:** in `#bot-commands`, `/reset-student` → pick the test account. Register again as **Juan Tester**. Expect "I couldn't find **Juan Tester** on the class list" with a **Register anyway** button. Click it: the test account is registered, and **`#join-log` pings you**. If there's no ping, recheck the `#join-log` row in 3.3.
6. **Clean up:** `/reset-student` the test account. Then `/import-classlist` with the **real** `IT110_classlist.csv` (it replaces the test copy; should report **43**). Delete the CSV copy from your Mac.
7. **Go live:** in `#welcome`, run `/post-register` → style **Re-registration** (a 403 means the START HERE row in 3.3 needs checking). Then delete `#welcome-test`.
8. **Update the `#welcome` topic** if it still has old instructions: ⚙️ next to `#welcome` → **Channel Topic** → e.g., *Click **Register** below to set your name and unlock #general.* → **Save Changes**.

### 3.8 Announce

As in [2.9](#29-announce-it), using `IT_110_Discord_Announcement.png` and the IT 110 invite link. Then [register in class](#210-register-in-class) and [nudge stragglers](#211-nudge-the-stragglers).

---

## If something looks off

| Situation | Fix |
|---|---|
| `/post-register` says "Discord error 403", or `#join-log` pings never arrive | Mingming has no permission entry on that channel. Sync the channel and check its **Mingming** entry ([How to set permissions](#how-to-set-permissions)). `npx wrangler tail` in Terminal shows these errors live; press **Control + C** to stop it |
| `#welcome` says "This is a threads only channel" | @everyone still has **Create Public Threads** allowed there. Set it (and Create Private Threads) to ❌ on START HERE, then sync `#welcome` |
| `/add-section` says the role has "staff powers" | The role still has default permissions. Open the role → **Permissions** tab → **Clear permissions** → Save, then try again |
| A student can't see `#welcome` | START HERE needs **@everyone: View Channel ✅** and **Read Message History ✅** ([2.3](#23-channels)). Check that `#welcome` is synced with the category |
| A student sees "I don't have permission" | Mingming's role must be above every role the student has ([2.2](#22-roles)) |
| A student can still change their nickname | Change Nickname must be OFF for @everyone ([2.4](#24-server-wide-everyone)) **and** for every other role they have (Clear permissions in [2.2](#22-roles)) |
| A student says they're in the wrong section | Check your class record first. If the record is right, Mingming placed them correctly. If the record changed, update the CSV and `/import-classlist` again, then `/reset-student` them so they re-register |
| A student dropped the course | Remove their row from the CSV, `/import-classlist` again, and kick them if they're in the server |
| "NO - please check" in the export | Compare with your class list: a misspelled name → `/reset-student` and ask them to retype it; not enrolled → kick them |
| "Already registered by another Discord account" | Someone registered with that name first. Check `/export-roster` to see which account, and `/reset-student` the wrong one |
| A student transfers mid-semester | Update your class record, re-export the CSV, `/import-classlist` it, then `/reset-student` the student |
| `npm run deploy` says "wrangler: command not found" or "EACCES" | The `node_modules` folder was damaged (usually by copying or syncing the project folder). Delete `node_modules`, then run `npm install` and deploy again |
