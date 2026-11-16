# Zajil (زاجل) 🕊️

An Arabic Discord bot for sending **private messages between members**, anonymously or openly. Members press a button in the server, write their message (with optional attachments), pick a recipient, and Zajil delivers it to the recipient's DMs. Everything is controlled by the owner and authorized staff from one settings menu.

![Zajil](screenshots/zajil-panel.png)

## Features

- **Send button panel**: a button in a chosen channel opens a compose window for the member
- **Private delivery**: the message arrives in the recipient's DMs as a styled embed
- **Anonymous or visible**: choose whether the sender’s identity is shown
- **Attachments**: images, GIFs, videos, and files (up to 10 per message)
- **Recipient picker**: pick one member from a list, or search by username or ID
- **Like and reply**: recipients can like a Zajil and reply once, using a text window or directly in the DM
- **Hidden log channel**: an auto-created `zajil-log` channel records sends, replies, and likes, including attachments
- **Banned words filter**: blocks messages containing words you define
- **Member blocking**: block a member from sending Zajil for a set time or permanently
- **Full customization**: embed color, button styles, display image, bot name, avatar, banner, status, and all messages
- **Access control**: settings are limited to the app owner and authorized users
- **Arabic-first interface**

## Commands

The default prefix is `%` and can be changed from the settings menu.

| Command | Description |
|---------|-------------|
| `%settings` or `%اعدادات` | Opens the settings menu |
| `%حظر @member` or `%block @member` | Blocks a member from sending Zajil |
| `%unblock @member` or `%الغاء حظر @member` | Removes the block |

All commands are restricted to the owner and authorized users.

## Settings menu

| Area | What you can change |
|------|---------------------|
| Prefix | The bot’s command prefix |
| Authorized users | Add or remove staff, view the list |
| Bot identity | Name, avatar, banner, and status |
| Zajil panel | Display image, send button style, and the channel the panel is posted in |
| Delivery | Anonymous or visible sending, like and reply buttons, reply input mode |
| Appearance | Embed color, Zajil message and emoji, like and reply button styles |
| Messages | Like notification text and reply request text |
| Moderation | Banned words, block and unblock members |
| Logging | Create the hidden `zajil-log` channel |

## Screenshots

| Zajil panel | Compose window |
|-------------|----------------|
| ![Panel](screenshots/zajil-panel.png) | ![Compose](screenshots/zajil-compose.png) |

| Recipient search | Settings menu |
|------------------|---------------|
| ![Search](screenshots/zajil-search.png) | ![Settings](screenshots/zajil-settings.png) |

## Tech Stack

- Runtime: Node.js
- Library: discord.js v14
- Config: dotenv, plus a local JSON settings file

## Setup

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/moath555/Zajil.git
   cd Zajil
   npm install
   ```
2. Create a `.env` file in the project root:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   OWNER_IDS=your_discord_user_id
   ```
   > ⚠️ Never commit your token. `.env` is already listed in `.gitignore`.
3. In the Discord Developer Portal, enable **Message Content Intent** and **Server Members Intent**.
4. Start the bot:
   ```bash
   npm start
   ```
   On Windows you can also run `start.bat`.

## Usage

1. Invite the bot to your server.
2. Type `%settings` in a staff channel and use the menu to post the Zajil panel in a channel.
3. Members press the send button, write their message, and choose a recipient.

## Ownership

**Owner & Developer:** Moaath Al-Shammari  
**GitHub:** [moath555](https://github.com/moath555)

## License

All rights reserved © Moaath Al-Shammari.
